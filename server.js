// server.js
const express = require('express');
const path = require('path');
const postgres = require('postgres');

const app = express();
app.use(express.json());

// Serve static files (index.html etc.) from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ────────────────────────────────────────────────────────────
function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return postgres(process.env.DATABASE_URL, {
    ssl: 'require',
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

// ── /api/signup ───────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { username, firstName, lastName, passwordHash } = req.body;
  if (!username || !firstName || !lastName || !passwordHash) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  let sql;
  try {
    sql = getDb();

    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        first_name    TEXT NOT NULL,
        last_name     TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const existing = await sql`SELECT id FROM users WHERE username = ${username}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: `Username "${username}" is already taken.` });
    }

    await sql`
      INSERT INTO users (username, first_name, last_name, password_hash)
      VALUES (${username}, ${firstName}, ${lastName}, ${passwordHash})
    `;

    return res.status(200).json({ success: true, username, firstName, lastName });

  } catch (err) {
    console.error('Signup error:', err.message);
    return res.status(500).json({ error: 'Server error during signup' });
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
});

// ── /api/login ────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, passwordHash } = req.body;
  if (!username || !passwordHash) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  let sql;
  try {
    sql = getDb();

    const rows = await sql`
      SELECT username, first_name, last_name, password_hash
      FROM users WHERE username = ${username}
    `;

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Username not found. Check spelling or sign up.' });
    }

    const user = rows[0];
    if (user.password_hash !== passwordHash) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const progress = await sql`
      SELECT question_id FROM student_progress WHERE username = ${username}
    `;
    const completedIds = progress.map(r => r.question_id);

    return res.status(200).json({
      success: true,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      completedIds,
    });

  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Server error during login' });
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
});

// ── /api/grade ────────────────────────────────────────────────────
app.post('/api/grade', async (req, res) => {
  const { question, answer, username, questionId } = req.body;

  if (!question || !answer) {
    return res.status(400).json({ error: 'Missing question or answer' });
  }

  const canSave = username && questionId !== undefined && questionId !== null;

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured' });
  }

  const prompt = `You are a strict but fair computer programming examiner grading a student's answer.

Question: ${question}

Student's Answer: ${answer}

Grade this answer. Respond ONLY with a valid JSON object in exactly this format:
- If the answer is correct or substantially correct: {"status": "Correct"}
- If the answer is wrong or incomplete: {"status": "Incorrect", "hint": "One short, helpful hint to guide the student (max 20 words)"}

Be strict: vague or incomplete answers should be marked Incorrect. But do not penalise for minor grammar or formatting issues — focus on conceptual correctness.
Respond with JSON only. No extra text.`;

  let parsed;
  try {
    const aiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.1,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error('Groq API error:', errText);
      return res.status(502).json({ error: 'AI service error' });
    }

    const aiData = await aiResponse.json();
    const raw = aiData.choices?.[0]?.message?.content?.trim() || '';

    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = raw.toLowerCase().includes('correct')
        ? { status: 'Correct' }
        : { status: 'Incorrect', hint: 'Review the concept and try again.' };
    }

  } catch (err) {
    console.error('Groq fetch error:', err);
    return res.status(500).json({ error: 'Internal server error during grading' });
  }

  if (parsed.status === 'Correct' && canSave) {
    let sql;
    try {
      sql = getDb();

      await sql`
        CREATE TABLE IF NOT EXISTS student_progress (
          id            SERIAL PRIMARY KEY,
          username      TEXT        NOT NULL,
          question_id   INTEGER     NOT NULL,
          completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (username, question_id)
        )
      `;

      await sql`
        INSERT INTO student_progress (username, question_id, completed_at)
        VALUES (${username}, ${Number(questionId)}, NOW())
        ON CONFLICT (username, question_id)
        DO UPDATE SET completed_at = NOW()
      `;

      console.log(`Saved: username="${username}" question_id=${questionId}`);
    } catch (dbErr) {
      console.error('Database error (non-fatal):', dbErr.message);
    } finally {
      if (sql) await sql.end({ timeout: 5 }).catch(() => {});
    }
  }

  return res.status(200).json(parsed);
});

// ── /api/leaderboard ──────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  let sql;
  try {
    sql = getDb();

    const rows = await sql`
      SELECT 
        u.username,
        u.first_name,
        u.last_name,
        COUNT(sp.question_id) AS questions_done
      FROM users u
      LEFT JOIN student_progress sp ON u.username = sp.username
      GROUP BY u.username, u.first_name, u.last_name
      ORDER BY questions_done DESC, u.username ASC
    `;

    const leaderboard = rows.map(row => ({
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      done: Number(row.questions_done),
    }));

    return res.status(200).json(leaderboard);

  } catch (err) {
    console.error('Leaderboard DB error:', err.message);
    return res.status(500).json({ error: 'Could not load leaderboard' });
  } finally {
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  }
});

// ── Catch-all: serve index.html for any unknown route ─────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

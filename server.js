const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.set('trust proxy', 1); // Render terminates TLS at a proxy; needed for real client IPs.
app.use(express.json({ limit: '10mb' }));

// SECURITY: express.static(__dirname) serves the whole repo, so explicitly
// block backend source, manifests, and git internals from public download.
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    p === '/server.js' ||
    p === '/package.json' ||
    p === '/package-lock.json' ||
    p.startsWith('/.git') ||
    p.startsWith('/node_modules')
  ) {
    return res.status(404).send('Not found');
  }
  next();
});

// Basic per-IP rate limit on the API. The interview averages about one message
// per minute, so 25 requests per 5 minutes is generous for a real parent while
// stopping bots from burning the Anthropic key or spamming transcripts.
const rateBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const WINDOW_MS = 5 * 60 * 1000;
  const MAX_REQUESTS = 25;
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= MAX_REQUESTS) {
    rateBuckets.set(ip, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(ip, hits);
  // Opportunistic cleanup so the map never grows unbounded.
  if (rateBuckets.size > 5000) {
    for (const [key, times] of rateBuckets) {
      if (!times.some(t => now - t < WINDOW_MS)) rateBuckets.delete(key);
    }
  }
  return false;
}

app.use('/api/', (req, res, next) => {
  if (isRateLimited(req.ip)) {
    // Shaped like Anthropic's rate-limit error so the existing client-side
    // retry/backoff logic in chat.js handles it gracefully.
    return res.status(429).json({ error: { type: 'rate_limit_error', message: 'Too many requests. Please wait a moment.' } });
  }
  next();
});

app.use(express.static(path.join(__dirname)));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';

// ─── ANTHROPIC CHAT ────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const model = req.body.useFastModel
      ? 'claude-haiku-4-5-20251001'
      : 'claude-sonnet-4-6';

    const body = { ...req.body };
    delete body.useFastModel;
    body.model = model;
    // Clamp token budget — the page never requests more than 6000, so anything
    // higher is someone hitting the endpoint directly.
    body.max_tokens = Math.min(Number(body.max_tokens) || 1200, 8000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    console.log('Model used:', model, '| Status:', response.status);

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── SAVE TRANSCRIPT ───────────────────────────────────────────────────────
app.post('/api/save-transcript', async (req, res) => {
  const { parentName, parentEmail, messages, blueprintText, timestamp } = req.body;

  const date = new Date(timestamp || Date.now());
  const dateStr = date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const transcriptFormatted = messages.map(m => {
    const role = m.role === 'user' ? 'PARENT' : 'INTERVIEWER';
    return `${role}:\n${m.content}\n`;
  }).join('\n─────────────────────────────────────\n\n');

  const emailSubject = `OTS Deep Work Transcript — ${parentName || 'Anonymous'} — ${dateStr}`;
  const emailBody = `
NEW FAMILY MONEY STORY INTERVIEW COMPLETED
==========================================
Parent Name: ${parentName || 'Not provided'}
Parent Email: ${parentEmail || 'Not provided'}
Date: ${dateStr}
Messages exchanged: ${messages.length}

==========================================
BLUEPRINT GENERATED
==========================================
${blueprintText || 'Blueprint text not captured'}

==========================================
FULL TRANSCRIPT
==========================================

${transcriptFormatted}
`;

  const results = { email: false, sheets: false };

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_TO || process.env.EMAIL_USER,
      subject: emailSubject,
      text: emailBody
    });
    results.email = true;
    console.log('Email sent for:', parentName);
  } catch (err) {
    console.error('Email error:', err.message);
  }

  if (SHEETS_WEBHOOK_URL) {
    try {
      await fetch(SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentName: parentName || 'Anonymous',
          parentEmail: parentEmail || '',
          date: dateStr,
          messageCount: messages.length,
          blueprintSnippet: (blueprintText || '').substring(0, 500),
          fullTranscript: transcriptFormatted
        })
      });
      results.sheets = true;
      console.log('Sent to Google Sheets for:', parentName);
    } catch (err) {
      console.error('Sheets webhook error:', err.message);
    }
  }

  res.json({ success: true, results });
});

// ─── TEST ENDPOINT ─────────────────────────────────────────────────────────
// SECURITY: gated behind TEST_SAVE_KEY. Without the gate this was a public GET
// that fired a real email to Jay's inbox on every hit — bot traffic alone
// could flood it. Set TEST_SAVE_KEY in Render env, then call
// /api/test-save?key=<value> to use it. If the env var is unset, always 404.
app.get('/api/test-save', async (req, res) => {
  if (!process.env.TEST_SAVE_KEY || req.query.key !== process.env.TEST_SAVE_KEY) {
    return res.status(404).send('Not found');
  }
  try {
    const testPayload = {
      parentName: 'Test Parent',
      parentEmail: 'test@test.com',
      messages: [
        { role: 'assistant', content: 'Tell me who is under your roof.' },
        { role: 'user', content: 'Two kids, ages 15 and 12.' },
        { role: 'assistant', content: 'What is your biggest concern?' },
        { role: 'user', content: 'That they will not be financially prepared.' }
      ],
      blueprintText: 'TEST BLUEPRINT — verifying save works.',
      timestamp: new Date().toISOString()
    };

    const baseUrl = 'http://localhost:' + (process.env.PORT || 3000);
    const response = await fetch(baseUrl + '/api/save-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });

    const result = await response.json();
    res.json({ message: 'Test complete', results: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

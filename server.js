const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '10mb' }));
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
app.get('/api/test-save', async (req, res) => {
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

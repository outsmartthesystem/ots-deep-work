const express = require('express');
const helmet = require('helmet');
const path = require('path');
const nodemailer = require('nodemailer');
const interview = require('./interview');

// Node 18+ ships a global fetch, so node-fetch is no longer a dependency.
const app = express();
app.set('trust proxy', 1); // Render terminates TLS at a proxy; needed for real client IPs.

// ─── SECURITY HEADERS ──────────────────────────────────────────────────────
// Helmet + a Content Security Policy. Scripts are same-origin only: html2pdf is
// now vendored locally (vendor/) instead of loaded from cdnjs, so no external
// script origin is allowed. 'unsafe-eval' is required ONLY because html2pdf's
// bundled regenerator runtime builds itself via the Function constructor at
// load; without it the PDF download breaks. Inline event handlers were removed
// from index.html, so script-src does NOT need 'unsafe-inline'. Google Fonts
// (CSS from googleapis, fonts from gstatic) are the only external resources.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Google Analytics (gtag.js) is the one allowed external script origin,
      // added for funnel analytics. GA4 sends its hits to google-analytics.com /
      // analytics.google.com, so those are allowed under connect-src below.
      scriptSrc: ["'self'", "'unsafe-eval'", 'https://www.googletagmanager.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  // The HTML/PDF flow does not need cross-origin isolation; leaving COEP off
  // avoids blocking the cdnjs/Google-Fonts loads.
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '2mb' }));

// SECURITY: express.static(__dirname) serves the whole repo, so explicitly
// block backend source, the prompt files (which contain the entire interview
// design), manifests, tests, and git internals from public download. shared.js
// and chat.js are intentionally NOT blocked — the browser needs them.
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    p === '/server.js' ||
    p === '/interview.js' ||
    p === '/package.json' ||
    p === '/package-lock.json' ||
    p.startsWith('/prompts') ||
    p.startsWith('/tests') ||
    p.endsWith('.test.js') ||
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

// The transcript/Sheets automation URL (e.g. a Make "Custom webhook"). It used
// to be hardcoded in the browser; it now lives in a server env var so it can be
// rotated without a deploy and can never be hit directly by a stranger.
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || '';

// ─── INPUT VALIDATION HELPERS ───────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 200) return false;
  return messages.every(m =>
    m && (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' && m.content.length <= 20000
  );
}

function sanitizeMeta(meta) {
  // The browser may only influence the prompt through a small, bounded set of
  // values. Everything is coerced to a safe shape before it reaches the prompt.
  const m = meta && typeof meta === 'object' ? meta : {};
  const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const c = m.captured && typeof m.captured === 'object' ? m.captured : {};
  return {
    parentFirstName: cap(m.parentFirstName, 80),
    blueprintDelivered: !!m.blueprintDelivered,
    captured: {
      F1: cap(c.F1, 200), F2: cap(c.F2, 200), F3: cap(c.F3, 200),
      F4: cap(c.F4, 1000), F5: cap(c.F5, 2000), F6: cap(c.F6, 2000),
      pattern: cap(c.pattern, 2000),
      tier: cap(c.tier, 10),
    },
  };
}

// ─── ANTHROPIC CHAT ────────────────────────────────────────────────────────
// The browser sends ONLY the conversation messages plus a small metadata
// object. The system prompt, model, token budget, and per-turn note are all
// decided server-side in interview.js. The browser cannot supply `system`,
// `model`, or `max_tokens`.
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, meta } = req.body || {};

    if (!isValidMessages(messages)) {
      return res.status(400).json({ error: { type: 'invalid_request_error', message: 'messages must be a non-empty array of {role, content}.' } });
    }

    const anthropicBody = interview.prepareChatRequest({
      messages,
      meta: sanitizeMeta(meta),
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(anthropicBody)
    });

    const data = await response.json();
    console.log('Model used:', anthropicBody.model, '| Status:', response.status);

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── SAVE TRANSCRIPT (single canonical path) ─────────────────────────────────
// One endpoint owns transcript delivery. It fires once, at interview
// completion, and fans out to:
//   1. The parent — their Blueprint, and only their Blueprint.
//   2. Jay — the full transcript, Blueprint, feedback, tier, and pattern.
//   3. The Sheets/automation webhook (optional, server-side env var).
// Duplicate calls for the same session are ignored (de-dup by sessionId), which
// removes the old "transcript saved twice" failure mode.
const savedSessions = new Map(); // sessionId -> savedAt (ms)

function alreadySaved(sessionId) {
  if (!sessionId) return false;
  // Opportunistic cleanup of entries older than 24h.
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (savedSessions.size > 5000) {
    for (const [id, ts] of savedSessions) if (now - ts > DAY) savedSessions.delete(id);
  }
  return savedSessions.has(sessionId);
}

function formatTranscript(messages) {
  return messages.map(m => {
    const role = m.role === 'user' ? 'PARENT' : 'INTERVIEWER';
    return `${role}:\n${m.content}\n`;
  }).join('\n─────────────────────────────────────\n\n');
}

function buildParentEmailHTML(parentName, blueprintText) {
  // Self-contained, inline-styled email — does not rely on the site stylesheet.
  // Blueprint paragraphs are passed as already-structured plain text from the
  // browser; we wrap each block in a styled paragraph. All values are escaped.
  const esc = (s) => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  // After escaping, turn any bare URL (e.g. the "Book your call here: https://…"
  // line carried over from the Blueprint) into a real clickable link.
  const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#a8631e;font-weight:bold;">$1</a>');
  const paragraphs = String(blueprintText || '')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => `<p style="margin:0 0 18px;font-size:15px;line-height:1.75;color:#2a2a2a;white-space:pre-wrap;">${linkify(esc(block))}</p>`)
    .join('\n');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f1ea;">
  <div style="max-width:640px;margin:0 auto;padding:32px 20px;font-family:Georgia,'Times New Roman',serif;">
    <div style="background:#ffffff;border:1px solid #e8dccb;border-top:4px solid #c9866c;padding:40px 36px;">
      <p style="font-family:Arial,sans-serif;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:#a87a4e;margin:0 0 8px;">Outsmart the System</p>
      <h1 style="font-size:24px;font-weight:normal;color:#1a1a1a;margin:0 0 4px;">Your Family Money Story Blueprint</h1>
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#888;margin:0 0 28px;">Prepared for ${esc(parentName || 'you')}</p>
      <hr style="border:none;border-top:1px solid #e8dccb;margin:0 0 28px;">
      ${paragraphs}
      <hr style="border:none;border-top:1px solid #e8dccb;margin:32px 0 20px;">
      <p style="font-size:14px;line-height:1.7;color:#5a5a5a;margin:0;">This is your mirror — not the work itself. Read the section on what your kids are absorbing again tomorrow, and try the first move within seven days. If it's a fit, you'll have the option to book an alignment call with Jay. No pressure.</p>
    </div>
    <p style="font-family:Arial,sans-serif;text-align:center;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#b0a99c;margin:20px 0 0;">Outsmart the System &mdash; outsmartthesystem.org</p>
  </div>
  </body></html>`;
}

app.post('/api/save-transcript', async (req, res) => {
  const {
    sessionId, parentName, parentEmail, messages,
    blueprintText, blueprintHTML, capturedTier, capturedPattern, feedback, timestamp, utm,
  } = req.body || {};

  // ── Validation (audit HP5): the browser may not save arbitrary payloads. ──
  if (!isValidMessages(messages)) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  const assistantTurns = messages.filter(m => m.role === 'assistant').length;
  if (assistantTurns < 15) {
    // A real interview has 20+ assistant turns. Fewer means a premature or
    // bogus trigger — refuse rather than send Jay a blank record.
    return res.status(400).json({ error: 'transcript too short to be a completed interview' });
  }
  if (parentEmail && !EMAIL_RE.test(String(parentEmail))) {
    return res.status(400).json({ error: 'parentEmail is not a valid email' });
  }
  if (typeof blueprintText !== 'string' || blueprintText.trim().length < 20) {
    return res.status(400).json({ error: 'blueprint missing' });
  }

  // ── De-dup: one save per session. ──
  if (alreadySaved(sessionId)) {
    return res.json({ success: true, deduped: true });
  }
  if (sessionId) savedSessions.set(String(sessionId), Date.now());

  const date = new Date(timestamp || Date.now());
  const dateStr = date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const fb = feedback && typeof feedback === 'object' ? feedback : {};
  // UTM attribution captured at landing (optional). Coerce to safe strings so a
  // crafted client payload can't inject anything into the email/webhook.
  const u = utm && typeof utm === 'object' ? utm : {};
  const capUtm = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
  const utmSource = capUtm(u.utm_source);
  const utmMedium = capUtm(u.utm_medium);
  const utmCampaign = capUtm(u.utm_campaign);
  const transcriptFormatted = formatTranscript(messages);
  const results = { parentEmail: false, internalEmail: false, sheets: false };

  // ── 1. Parent email — their Blueprint only, no internal notes/transcript. ──
  if (parentEmail) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: parentEmail,
        subject: 'Your Family Money Story Blueprint',
        text: `Hi ${parentName || 'there'},\n\nYour Family Money Story Blueprint is below. This is your mirror — read it again tomorrow, and try the first move within seven days.\n\n${blueprintText}\n\n— Outsmart the System`,
        html: buildParentEmailHTML(parentName, blueprintText),
      });
      results.parentEmail = true;
      console.log('Parent Blueprint email sent to:', parentEmail);
    } catch (err) {
      console.error('Parent email error:', err.message);
    }
  }

  // ── 2. Internal email — everything Jay needs to review the interview. ──
  const internalBody = `
NEW FAMILY MONEY STORY INTERVIEW COMPLETED
==========================================
Parent Name: ${parentName || 'Not provided'}
Parent Email: ${parentEmail || 'Not provided'}
Date: ${dateStr}
Assistant turns: ${assistantTurns}
Blueprint Tier: ${capturedTier || 'Not captured'}
Pattern Picked: ${capturedPattern || 'Not captured'}

CAMPAIGN ATTRIBUTION
--------------------
utm_source:   ${utmSource || '—'}
utm_medium:   ${utmMedium || '—'}
utm_campaign: ${utmCampaign || '—'}

FEEDBACK SCORES
---------------
F1 (safety, first 2 min): ${fb.F1 || '—'}
F2 (clarity on next step): ${fb.F2 || '—'}
F3 (how custom it felt):   ${fb.F3 || '—'}
F4 (book / come back):     ${fb.F4 || '—'}
F5 (moment that landed):   ${fb.F5 || '—'}
F6 (moment that felt off): ${fb.F6 || '—'}

==========================================
BLUEPRINT
==========================================
${blueprintText || 'Blueprint text not captured'}

==========================================
FULL TRANSCRIPT
==========================================

${transcriptFormatted}
`;
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_TO || process.env.EMAIL_USER,
      subject: `OTS Deep Work Transcript — ${parentName || 'Anonymous'} — ${dateStr}`,
      text: internalBody,
    });
    results.internalEmail = true;
    console.log('Internal transcript email sent for:', parentName);
  } catch (err) {
    console.error('Internal email error:', err.message);
  }

  // ── 3. Sheets / automation webhook (optional). ──
  if (SHEETS_WEBHOOK_URL) {
    try {
      await fetch(SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentName: parentName || 'Anonymous',
          parentEmail: parentEmail || '',
          date: dateStr,
          messageCount: assistantTurns,
          blueprintTier: capturedTier || '',
          patternPicked: capturedPattern || '',
          utmSource: utmSource,
          utmMedium: utmMedium,
          utmCampaign: utmCampaign,
          f1Score: fb.F1 || '', f2Score: fb.F2 || '', f3Score: fb.F3 || '',
          f4Score: fb.F4 || '', f5Answer: fb.F5 || '', f6Answer: fb.F6 || '',
          blueprintSnippet: String(blueprintText || '').substring(0, 500),
          fullTranscript: transcriptFormatted,
        })
      });
      results.sheets = true;
      console.log('Sent to Sheets webhook for:', parentName);
    } catch (err) {
      console.error('Sheets webhook error:', err.message);
    }
  }

  res.json({ success: true, results });
});

// ─── TEST ENDPOINT ─────────────────────────────────────────────────────────
// SECURITY: gated behind TEST_SAVE_KEY. Set TEST_SAVE_KEY in Render env, then
// call /api/test-save?key=<value>. If the env var is unset, always 404.
app.get('/api/test-save', async (req, res) => {
  if (!process.env.TEST_SAVE_KEY || req.query.key !== process.env.TEST_SAVE_KEY) {
    return res.status(404).send('Not found');
  }
  try {
    const filler = Array.from({ length: 11 }, (_, i) => ([
      { role: 'assistant', content: `Question ${i + 1}.` },
      { role: 'user', content: `Answer ${i + 1}.` },
    ])).flat();
    const testPayload = {
      sessionId: 'test_' + Date.now(),
      parentName: 'Test Parent',
      parentEmail: process.env.EMAIL_TO || process.env.EMAIL_USER,
      messages: filler,
      blueprintText: 'TEST BLUEPRINT — verifying save works end to end.',
      capturedTier: '1',
      capturedPattern: 'Scarcity Default',
      feedback: { F1: '9', F2: '8', F3: '9', F4: '7', F5: 'The childhood room moment.', F6: 'Nothing felt off.' },
      timestamp: new Date().toISOString(),
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
// Don't start listening when imported by the test suite.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;

# Deep Work Interview — Audit Fixes

This documents the changes made in response to the ChatGPT audit of the
Family Money Story Interview (`ots-deep-work`), what you (Jay) still need to do,
and what was intentionally deferred.

---

## What changed

### Architecture: the prompt and interview control are now server-side
The entire system prompt used to ship inside `chat.js`, so the whole interview
design was public, and `/api/chat` forwarded whatever `system` / `model` /
`max_tokens` the browser sent — i.e. an open Anthropic proxy.

- The system prompt now lives in **`prompts/interview_system.md`** and the
  per-turn anchor note in **`prompts/interview_note.md`**, read at startup by
  **`interview.js`**. These files are blocked from public download by the static
  guard in `server.js`.
- **`/api/chat`** now accepts **only** `{ messages, meta }`. The server decides
  `system`, `model`, `max_tokens`, and injects the per-turn note. The browser
  cannot set any of those. `messages` is validated (array, roles, length caps);
  `meta` is sanitized (name + captured feedback values, all length-capped).
- `shared.js` holds the DOM-free helpers used by browser, server, and tests
  (`isInterviewComplete`, `stripSentinel`, `stripFeedbackBlockForDisplay`,
  `isBlueprintTrigger`, `classify*`, `escapeHTML`, `sanitizeBlueprintHTML`).

### Transcript delivery: one canonical path, real parent email
- The hardcoded **Make webhook was removed from `chat.js`** (it was a public
  secret endpoint).
- `/api/save-transcript` is now the single path. It fires **once**, at interview
  completion, and **de-dupes by `sessionId`** (kills the "saved twice" bug). It:
  1. emails the **parent their Blueprint only** (no transcript/internal notes),
  2. emails **Jay the full record** (transcript + Blueprint + feedback + tier +
     pattern),
  3. optionally POSTs to a **server-side** automation/Sheets webhook.
- Payloads are validated (valid email, real-length transcript, blueprint
  present, min turn count).

### Security hardening
- **Helmet + Content Security Policy** added. Scripts are same-origin only.
- **html2pdf is vendored locally** at `vendor/html2pdf.bundle.min.js` (was
  cdnjs), so it's pinned and same-origin. (`'unsafe-eval'` is allowed in the CSP
  solely because html2pdf's bundled regenerator runtime builds itself via the
  `Function` constructor; without it the PDF download breaks.)
- Inline `onclick` handlers were removed from `index.html` and wired in JS so
  the CSP can forbid inline scripts.
- **PDF XSS edge case fixed**: the parent name is `escapeHTML`-escaped before
  being interpolated into the PDF header.
- `node-fetch` dropped in favor of Node 18+ global `fetch`; `engines.node >=18`.
- `package-lock.json` added (run `npm install`).

### Trust / privacy / safety UX
- Intake copy rewritten — **removed "This is not a sales funnel."** Now states
  plainly that answers generate the Blueprint, that Jay may review completed
  interviews, that you can skip questions, and that an optional call may follow.
- **Safety footer** before "Begin": not therapy / not crisis support / not
  financial-legal-mental-health advice / you can stop anytime / **988** crisis
  line (call, text, or chat, 24/7).
- **localStorage consent**: a checkbox at intake gates on-device saving. Default
  **off** — nothing sensitive is written to the device unless the parent opts
  in. A **"Clear my saved interview"** control lets them wipe it.
- Landing **expectation bullets** (~22 questions, skip anything, Blueprint at the
  end, do it alone) and **"Best for parents of kids ages 10–18."**
- Progress bar is now **stop-based** ("Stop 2 of 4 — Where the Story Started")
  instead of the misleading per-turn estimate.

### Tests
- Jest suite under `tests/` covering the completion/blueprint/feedback
  detection, the HTML sanitizer (jsdom), and the server prompt/model/token logic.
  Run with `npm test`.

---

## What YOU (Jay) need to do

1. **Rotate the Make webhook.** The old URL was public in the client for a while
   — treat it as compromised. In Make, regenerate the Custom Webhook URL.
2. **Set Render environment variables:**
   - `ANTHROPIC_API_KEY` — (already set)
   - `EMAIL_USER`, `EMAIL_PASS` — Gmail account + app password (already set)
   - `EMAIL_TO` — where the internal/full transcript email goes (your inbox)
   - `SHEETS_WEBHOOK_URL` — the **new** (rotated) Make/Sheets webhook URL. Leave
     unset to disable the Sheets push entirely.
   - `TEST_SAVE_KEY` — optional; enables `GET /api/test-save?key=...`
3. **Confirm Render's Node version is 18+** (default is 20+, so fine).
4. **Verify the parent email actually sends** from your Gmail (the parent now
   receives their Blueprint; previously only Jay got an email). Send yourself a
   test via `/api/test-save?key=...`.

---

## Deferred (recommended next, not done here)

These were lower-priority or need live end-to-end testing of the full 22-question
interview before changing — doing them blind risks breaking a heavily-tuned flow.

- **Server-owned completion state (audit Critical 6).** Completion is still
  triggered by the model's `[INTERVIEW_COMPLETE]` sentinel. A fully code-owned
  completion needs server-side session storage (track `q22Answered`,
  `blueprintGenerated`). The prompt + request control already moved server-side;
  this is the remaining piece.
- **Abandonment safety net.** Because the single save fires at completion, a
  parent who closes the tab *after* the Blueprint but *before* finishing the 6
  feedback questions won't be saved. Server-side session state + a flush timer
  would cover this.
- **Prompt module split** into 5 files + runtime modes (interview / blueprint /
  feedback). The prompt is now its own server module; splitting further is a
  token-efficiency improvement.
- **Analytics events, error monitoring, per-IP/day cost guardrails, admin
  dashboard, consent logs** — the audit's "before paid traffic" list.
- **Staged opening cards** and **post-Blueprint bridge screen** — UX polish.

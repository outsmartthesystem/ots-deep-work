// ─────────────────────────────────────────────────────────────────────────────
// OTS Family Money Story Interview — browser wrapper
// ─────────────────────────────────────────────────────────────────────────────
// The system prompt and the interview-state strategy now live SERVER-SIDE
// (interview.js + prompts/*.md). This file is the display/state wrapper: it
// renders messages, captures the parent's typed feedback answers, persists the
// session for resume, and fires the single transcript save at completion. It
// can no longer see or change the prompt, the model, or the token budget.
//
// Shared, DOM-free helpers (isInterviewComplete, stripSentinel,
// stripFeedbackBlockForDisplay, isBlueprintTrigger, classifyFeedbackQuestion,
// classifyPatternQuestion, escapeHTML) come from shared.js, which loads before
// this file and exposes them as globals.
// ─────────────────────────────────────────────────────────────────────────────

const conversationHistory = [];
window.blueprintDelivered = false;
window.transcriptSent = false; // guards against double-sends if the wrapper retries

// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK & PATTERN CAPTURE (wrapper-level state tracking)
// ─────────────────────────────────────────────────────────────────────────────
// The model previously had to remember F1-F4 numeric answers across many turns
// and assemble them into the FEEDBACK FOR JAY block at the very end. That
// approach failed repeatedly across v12.4, v12.8, and v12.9 — scores got
// dropped or hallucinated, the pattern name got invented as a different one
// than what the parent actually picked, and the tier got marked "Unable to
// determine" even when it was determined silently.
//
// This module solves the problem at the wrapper level: the wrapper itself
// captures the feedback scores and pattern name as the conversation happens,
// then injects those captured values directly into the system prompt at API
// call time. The model no longer has to retrieve from memory — the values
// appear in its instructions.
//
// Detection works by inspecting assistant messages for distinctive question
// phrases. When the wrapper sees F1's question text emitted by the assistant,
// it sets activeFeedbackQuestion = 'F1'. The parent's next message gets
// captured as F1's answer. Same logic for F2-F6 and the pattern pick at Q12.
//
// The tier is captured via a sentinel the model emits at the very start of
// the Blueprint: [BLUEPRINT_TIER:1] (or 2 or 3). The wrapper strips the
// sentinel before display and stores the tier number for later substitution.

window.capturedFeedback = {
  F1: null, F2: null, F3: null, F4: null, F5: null, F6: null,
};
window.capturedPattern = null; // The pattern the parent picked at Q12, verbatim.
window.capturedTier = null;    // 1, 2, or 3 — the tier the model determined.
window.activeFeedbackQuestion = null; // 'F1', 'F2', etc. — set by detector, cleared on capture.
window.activePatternQuestion = false; // true when the wrapper is waiting for the Q12 answer.

const TIER_SENTINEL_REGEX = /\[BLUEPRINT_TIER:(\d)\]/;

function detectAndUpdateActiveQuestion(assistantMessage) {
  // Arm feedback/pattern capture based on the assistant's latest message so the
  // parent's NEXT message can be stored as that answer.
  //
  // The phrase-matching itself lives in shared.js (classifyFeedbackQuestion /
  // classifyPatternQuestion) — one definition, directly unit-tested. This
  // wrapper just applies the result to window state. Like the original, it only
  // SETS when a phrase matches; it never clears, so an unrelated assistant turn
  // leaves any pending capture armed.
  const fq = classifyFeedbackQuestion(assistantMessage);
  if (fq) window.activeFeedbackQuestion = fq;
  if (classifyPatternQuestion(assistantMessage)) window.activePatternQuestion = true;
}

function captureUserAnswer(userText) {
  // Called when the parent sends a message. If the wrapper is currently
  // waiting for a feedback answer or a pattern pick, store it.
  if (window.activeFeedbackQuestion) {
    const q = window.activeFeedbackQuestion;
    // F1-F4 should be numeric. Try to extract a number; fall back to verbatim.
    if (q === 'F1' || q === 'F2' || q === 'F3' || q === 'F4') {
      // Tier 3's F4 is free-text, not numeric — store verbatim.
      // For everything else, try to parse a 1-10 number.
      const match = userText.match(/\b(10|[1-9])\b/);
      if (match && q !== 'F4') {
        window.capturedFeedback[q] = match[1];
      } else if (match && q === 'F4') {
        // Numeric F4 (Tier 1 or 2) — store the number.
        window.capturedFeedback[q] = match[1];
      } else {
        // No number found — store verbatim (likely Tier 3 free-text or skipped).
        window.capturedFeedback[q] = userText.trim();
      }
    } else {
      // F5, F6 — verbatim text.
      window.capturedFeedback[q] = userText.trim();
    }
    window.activeFeedbackQuestion = null;
  }

  if (window.activePatternQuestion) {
    // Capture the pattern pick verbatim. This is what gets quoted back in the
    // FEEDBACK FOR JAY internal note so the model can't hallucinate a
    // different pattern.
    window.capturedPattern = userText.trim();
    window.activePatternQuestion = false;
  }
}

function captureTierFromAssistantMessage(assistantMessage) {
  // The model emits a sentinel like [BLUEPRINT_TIER:1] at the very start of
  // the Blueprint. Capture the tier number and strip the sentinel so the
  // parent doesn't see it.
  const match = assistantMessage.match(TIER_SENTINEL_REGEX);
  if (match) {
    window.capturedTier = match[1];
    return assistantMessage.replace(TIER_SENTINEL_REGEX, '').trim();
  }
  return assistantMessage;
}

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SESSION PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
// Saves session state to localStorage after every turn so the parent can
// recover from a refresh, crash, or accidental tab close. The 35-45 minute
// interview is too long to lose to a connection blip — and the emotional
// disclosures involved make losing one a relationship-damaging event.
//
// Storage shape:
//   ots_session_v1: {
//     sessionId, parentFirstName, parentEmail, conversationHistory,
//     blueprintDelivered, transcriptSent, savedAt (ISO timestamp)
//   }
//
// Sessions older than 24 hours are cleared on page load (the parent has moved
// on by then). Sessions where the transcript was already sent are not eligible
// for resume — they're complete. Sessions are always per-browser (localStorage
// is origin-scoped, no cross-device sync).

const SESSION_STORAGE_KEY = 'ots_session_v1';
const SESSION_MAX_AGE_HOURS = 24;

function generateSessionId() {
  // Short readable ID with timestamp prefix so duplicate detection is easy.
  return 'ots_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
}

function saveSession() {
  // Called after every turn. Cheap operation — localStorage writes are fast.
  if (!window.sessionId) return; // No active session to save.

  // Privacy (audit Critical 7): only persist sensitive interview state to this
  // device if the parent explicitly opted in at intake. Without consent we keep
  // everything in memory for the live session and write nothing to disk.
  if (!window.saveConsent) return;

  const state = {
    sessionId: window.sessionId,
    parentFirstName: window.parentFirstName || '',
    parentEmail: window.parentEmail || '',
    conversationHistory: conversationHistory,
    blueprintDelivered: window.blueprintDelivered || false,
    transcriptSent: window.transcriptSent || false,
    capturedFeedback: window.capturedFeedback || {
      F1: null, F2: null, F3: null, F4: null, F5: null, F6: null,
    },
    capturedPattern: window.capturedPattern || null,
    capturedTier: window.capturedTier || null,
    activeFeedbackQuestion: window.activeFeedbackQuestion || null,
    activePatternQuestion: window.activePatternQuestion || false,
    savedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // localStorage can fail in private browsing or if quota is exceeded.
    // Persistence is a nice-to-have, not blocking — log and continue.
    console.warn('Could not save session:', err);
  }
}

function loadSession() {
  // Returns the saved session if eligible for resume, otherwise null.
  // Eligibility: must exist, must be under 24 hours old, must not be complete.
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;

    const state = JSON.parse(raw);
    if (!state.sessionId || !state.savedAt) return null;

    // Check age.
    const savedAt = new Date(state.savedAt);
    const ageHours = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > SESSION_MAX_AGE_HOURS) {
      clearSession();
      return null;
    }

    // Don't resume completed sessions.
    if (state.transcriptSent) {
      clearSession();
      return null;
    }

    return state;
  } catch (err) {
    console.warn('Could not load session:', err);
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (err) {
    console.warn('Could not clear session:', err);
  }
}

function resumeSession(state) {
  // Restore all session state and rebuild the chat UI from saved history.
  window.sessionId = state.sessionId;
  window.parentFirstName = state.parentFirstName;
  window.parentName = state.parentFirstName; // legacy alias
  window.parentEmail = state.parentEmail;
  window.blueprintDelivered = state.blueprintDelivered;
  window.transcriptSent = state.transcriptSent;
  // A saved session only exists because the parent opted into on-device saving,
  // so keep consent on (otherwise subsequent turns would stop persisting).
  window.saveConsent = true;
  const clearBtn = document.getElementById('clearSavedBtn');
  if (clearBtn) clearBtn.hidden = false;

  // Restore captured feedback values, pattern pick, tier, and active-question
  // state. Without these the wrapper would lose all captured values on resume.
  window.capturedFeedback = state.capturedFeedback || {
    F1: null, F2: null, F3: null, F4: null, F5: null, F6: null,
  };
  window.capturedPattern = state.capturedPattern || null;
  window.capturedTier = state.capturedTier || null;
  window.activeFeedbackQuestion = state.activeFeedbackQuestion || null;
  window.activePatternQuestion = state.activePatternQuestion || false;

  // Restore conversation history.
  conversationHistory.length = 0;
  state.conversationHistory.forEach(turn => conversationHistory.push(turn));

  // Set up UI: hide intake, show chat, set heading.
  document.getElementById('chat-heading').textContent = state.parentFirstName + "'s Interview";
  document.getElementById('intake-screen').style.display = 'none';
  document.getElementById('chat-screen').style.display = 'flex';

  // Rebuild the visible chat from history. Skip the synthetic seed message.
  const messages = document.getElementById('messages');
  while (messages.firstChild) messages.removeChild(messages.firstChild); // Safe clear.
  conversationHistory.forEach(turn => {
    if (turn.role === 'user') {
      if (turn.content.startsWith('My name is ')) return;
      let displayText = turn.content;
      if (displayText.includes('[Internal note for the interviewer:')) {
        const parts = displayText.split('\n\n');
        displayText = parts[parts.length - 1];
      }
      addMessage(displayText, 'user');
    } else {
      renderAssistantMessage(turn.content);
    }
  });

  updateProgress();
  document.getElementById('userInput').focus();
}
// ─────────────────────────────────────────────────────────────────────────────


function estimateQuestionProgress() {
  // Count assistant messages, subtract 1 for the opening, that's roughly the question we're on.
  // Cap at 22 since that's the max numbered question in v8.
  const assistantTurns = conversationHistory.filter(m => m.role === 'assistant').length;
  const estimate = Math.max(1, assistantTurns - 1);
  return Math.min(estimate, 22);
}

function currentStop() {
  // Map the estimated question (1-22) onto the four "stops" of the journey.
  if (window.blueprintDelivered) return { n: 5, label: 'Your Blueprint' };
  const q = estimateQuestionProgress();
  if (q <= 5)  return { n: 1, label: 'Stop 1 of 4 — Arrival' };
  if (q <= 11) return { n: 2, label: 'Stop 2 of 4 — Where the Story Started' };
  if (q <= 17) return { n: 3, label: 'Stop 3 of 4 — The Rule Still Running You' };
  return { n: 4, label: 'Stop 4 of 4 — What Your Kids Are Absorbing' };
}

function updateProgress() {
  // The bar + label track the four "stops" of the journey rather than a raw
  // turn count. The audit flagged the old per-turn estimate as misleading
  // (Q21 has two movements, discovery moves add turns, and the feedback
  // questions happen AFTER the Blueprint). Stops match the product architecture
  // and answer "how much longer?" honestly.
  const fill = document.getElementById('progressFill');
  const label = document.getElementById('stopLabel');
  const stop = currentStop();
  if (fill) {
    const pct = window.blueprintDelivered ? 100 : Math.round(((stop.n - 0.5) / 4) * 100);
    fill.style.width = pct + '%';
  }
  if (label) label.textContent = stop.label;
}


function isLateInInterview() {
  // Once we're past roughly Q18 in a 22-question interview, any user message could realistically
  // trigger the Blueprint. We bump the token budget so the Blueprint never gets truncated
  // mid-sentence, regardless of whether the user phrased their final answer as "wrap it up".
  const assistantTurns = conversationHistory.filter(m => m.role === 'assistant').length;
  return assistantTurns >= 18;
}

async function sendMessage() {
  const input = document.getElementById('userInput');
  const sendButton = document.getElementById('sendButton');
  const userText = input.value.trim();
  if (!userText || sendButton.disabled) return;

  addMessage(userText, 'user');
  input.value = '';
  autoResize(input);
  sendButton.disabled = true;

  // Loading-message heuristic is pure UX and stays client-side. The actual
  // token budget and model are decided SERVER-SIDE from the conversation.
  const blueprintIncoming = isBlueprintTrigger(userText);
  const lateInterview = isLateInInterview();
  const showBlueprintLoadingMessage = blueprintIncoming || (lateInterview && userText.length < 30);
  const thinking = addThinking(showBlueprintLoadingMessage);

  // Capture F1-F6 score answers and the Q12 pattern pick at the wrapper level.
  // detectAndUpdateActiveQuestion() ran on the previous assistant message and
  // armed window.activeFeedbackQuestion / activePatternQuestion.
  captureUserAnswer(userText);

  // Push the CLEAN user message. The per-turn "internal note" that anchors the
  // model to the numbered question is injected server-side now — the browser
  // only ever holds and sends clean text.
  conversationHistory.push({ role: 'user', content: userText });

  try {
    let data = null;
    let attempts = 0;
    const maxAttempts = 4;

    while (attempts < maxAttempts) {
      attempts++;

      // The browser sends ONLY the messages plus a small metadata object. It
      // cannot set system / model / max_tokens — the server owns all of that.
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: conversationHistory,
          meta: {
            parentFirstName: window.parentFirstName || '',
            blueprintDelivered: !!window.blueprintDelivered,
            captured: {
              F1: (window.capturedFeedback && window.capturedFeedback.F1) || null,
              F2: (window.capturedFeedback && window.capturedFeedback.F2) || null,
              F3: (window.capturedFeedback && window.capturedFeedback.F3) || null,
              F4: (window.capturedFeedback && window.capturedFeedback.F4) || null,
              F5: (window.capturedFeedback && window.capturedFeedback.F5) || null,
              F6: (window.capturedFeedback && window.capturedFeedback.F6) || null,
              pattern: window.capturedPattern || null,
              tier: window.capturedTier || null,
            },
          },
        }),
      });

      data = await response.json();

      if (data.error && data.error.type === 'rate_limit_error') {
        if (attempts < maxAttempts) {
          thinking.remove();
          const waitSeconds = attempts * 20;
          const waitEl = addMessage('One moment — taking a short pause before continuing...', 'thinking');
          await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
          waitEl.remove();
          const newThink = addThinking();
          thinking.remove = newThink.remove.bind(newThink);
          continue;
        } else {
          thinking.remove();
          addMessage('We hit a brief pause. Please type your last message again and we will continue right where we left off.', 'agent');
          sendButton.disabled = false;
          return;
        }
      }
      break;
    }

    if (!data || !data.content || !data.content[0]) {
      throw new Error(JSON.stringify(data));
    }

    const rawAssistantMessage = data.content[0].text;
    thinking.remove();

    // Capture + strip the [BLUEPRINT_TIER:N] sentinel before anything else, so
    // the parent never sees it and the wrapper has the tier locked in.
    const assistantMessage = captureTierFromAssistantMessage(rawAssistantMessage);

    // Completion is signalled by the sentinel. Strip it before display/storage.
    const interviewComplete = isInterviewComplete(assistantMessage);
    const cleanedMessage = interviewComplete ? stripSentinel(assistantMessage) : assistantMessage;

    // Store the full cleaned message (incl. the FEEDBACK FOR JAY block, which
    // the internal email needs); render only the display-stripped version.
    conversationHistory.push({ role: 'assistant', content: cleanedMessage });
    const displayMessage = interviewComplete
      ? stripFeedbackBlockForDisplay(cleanedMessage)
      : cleanedMessage;
    renderAssistantMessage(displayMessage);

    // Arm feedback/pattern capture for the parent's NEXT message.
    detectAndUpdateActiveQuestion(cleanedMessage);

    saveSession();
    updateProgress();

    // Single canonical transcript save — fires once, at completion. The server
    // sends the parent their Blueprint, sends Jay the full record, and de-dupes.
    if (interviewComplete) {
      saveTranscriptCanonical();
      saveSession(); // re-save to capture transcriptSent: true
    }

  } catch (error) {
    thinking.remove();
    addMessage('We hit a brief technical pause. Please type your last message again and we will continue right where we left off.', 'agent');
    console.error('Full error:', error);
  }

  sendButton.disabled = false;
  scrollToBottom();
}

function isBlueprint(text) {
  return text.includes('blueprint-container') || text.includes('blueprint-section-header');
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFE RENDERING
// ─────────────────────────────────────────────────────────────────────────────
// Helpers that safely render text and HTML without using innerHTML on
// untrusted content. User input and model output are both treated as untrusted
// by default. The Blueprint is the only HTML allowed through, and it goes
// through a strict allowlist sanitizer first.

function appendTextWithLineBreaks(parent, text) {
  // Render text into a DOM element, converting \n into <br> elements and
  // recognizing a tiny allowlist of inline tags (<em>, <strong>) that the
  // model and our own opening string use for emphasis. Everything else —
  // any other tags, attributes, scripts — gets escaped as text. This
  // preserves the italics in the recognition arc without using innerHTML
  // on untrusted content.
  //
  // The implementation: use a regex to match the allowed tags and route
  // matched content through createElement, while non-matched content goes
  // through createTextNode. Either way, no markup ever reaches innerHTML.

  const lines = text.split('\n');
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      parent.appendChild(document.createElement('br'));
    }

    // Match <em>...</em> or <strong>...</strong> spans. Anything else is text.
    const segmentRegex = /<(em|strong)>([\s\S]*?)<\/\1>/gi;
    let lastIndex = 0;
    let match;

    while ((match = segmentRegex.exec(line)) !== null) {
      // Append any text before this match as a plain text node.
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(line.substring(lastIndex, match.index)));
      }
      // Create the inline element via createElement and put the inner content
      // in as a text node — never innerHTML, so nested markup is impossible.
      const tag = match[1].toLowerCase();
      const innerText = match[2];
      const el = document.createElement(tag);
      el.textContent = innerText;
      parent.appendChild(el);
      lastIndex = segmentRegex.lastIndex;
    }

    // Append any trailing text after the last match.
    if (lastIndex < line.length) {
      parent.appendChild(document.createTextNode(line.substring(lastIndex)));
    }
  });
}

// sanitizeBlueprintHTML lives in shared.js (DOM-free at load, tested under
// jsdom). It is available here as a global because shared.js loads first.

function renderAssistantMessage(text) {
  const messages = document.getElementById('messages');

  if (isBlueprint(text)) {
    const startIdx = text.indexOf('<div class="blueprint-container">');
    if (startIdx > 0) {
      // The preamble before the Blueprint is plain text from the model.
      // Render it safely with textContent + <br> elements.
      const preamble = document.createElement('div');
      preamble.className = 'message agent';
      preamble.style.cssText = 'animation: fadeUp 0.4s ease forwards; opacity: 0;';
      appendTextWithLineBreaks(preamble, text.substring(0, startIdx));
      messages.appendChild(preamble);
    }

    // The Blueprint itself is HTML by design. Sanitize it through the
    // allowlist before inserting, so any unexpected tags are stripped.
    const blueprintDiv = document.createElement('div');
    blueprintDiv.style.cssText = 'animation: fadeUp 0.5s ease forwards; opacity: 0;';
    const html = startIdx !== -1 ? text.substring(startIdx) : text;
    const sanitizedHTML = sanitizeBlueprintHTML(html);
    blueprintDiv.innerHTML = sanitizedHTML;
    messages.appendChild(blueprintDiv);

    // The sanitizer strips the onclick="" attribute (correctly — that prevents
    // arbitrary script execution from model output). Re-attach the download
    // handler programmatically here. The .download-btn class was preserved.
    const downloadButtons = blueprintDiv.querySelectorAll('.download-btn');
    downloadButtons.forEach(btn => {
      btn.addEventListener('click', downloadBlueprint);
    });

    window.blueprintHTML = sanitizedHTML;
    window.blueprintDelivered = true;

    // GA4 funnel event: parent reached the Blueprint = interview complete.
    // Guarded so it can fire at most once per page load.
    if (!window.otsCompleteFired && window.otsTrack) {
      window.otsCompleteFired = true;
      otsTrack('interview_complete');
    }

    // Extract a structured plain-text Blueprint (block elements separated by
    // blank lines) for the parent + internal emails. Stored now; the single
    // canonical transcript save fires later, at interview completion — NOT here.
    // (The old early save here is what produced duplicate/inconsistent records.)
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = sanitizedHTML;
    window.blueprintText = blueprintToStructuredText(tempDiv);

  } else {
    // Regular assistant messages are plain text. Render with textContent
    // and proper <br> elements — never innerHTML.
    const div = document.createElement('div');
    div.className = 'message agent';
    div.style.cssText = 'animation: fadeUp 0.4s ease forwards; opacity: 0;';
    appendTextWithLineBreaks(div, text);
    messages.appendChild(div);
  }

  scrollToBottom();
}

function addMessage(text, type) {
  // Renders a user message OR a system status message. Both go through
  // safe text rendering — the user's typed content can never reach the
  // DOM as markup, regardless of what they typed.
  const messages = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message ' + type;
  div.style.cssText = 'animation: fadeUp 0.4s ease forwards; opacity: 0;';
  appendTextWithLineBreaks(div, text);
  messages.appendChild(div);
  scrollToBottom();
  return div;
}

function addThinking(blueprintMode = false) {
  const messages = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message thinking';
  if (blueprintMode) {
    // Blueprint generation takes 30-60 seconds. A blank thinking-dots indicator leaves
    // the parent wondering if the system broke. Replace it with a reassuring message
    // that matches the conversational frame held throughout the interview.
    div.innerHTML = 'Working on your Blueprint now. This will take about a minute. <span class="thinking-dots"></span>';
    div.style.fontStyle = 'italic';
    div.style.opacity = '0.85';
  } else {
    div.innerHTML = '<span class="thinking-dots"></span>';
  }
  messages.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  const area = document.getElementById('messagesArea');
  area.scrollTop = area.scrollHeight;
}

function scrollToTop() {
  const area = document.getElementById('messagesArea');
  area.scrollTop = 0;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function blueprintToStructuredText(root) {
  // Produce readable plain text from the sanitized Blueprint DOM: each leaf
  // block element becomes a paragraph separated by a blank line. Used for the
  // parent and internal emails (the on-page render and the PDF use the HTML
  // directly). Falls back to flat textContent if no block structure is found.
  //
  // Inline any <a href> URL into its own text first — plain-text extraction
  // drops hrefs, which is why the "Book your call here" CTA used to arrive in
  // the parent email with no actual link. `root` is a throwaway div, so
  // mutating it here does not affect the on-page Blueprint.
  root.querySelectorAll('a[href]').forEach(a => {
    const href = (a.getAttribute('href') || '').trim();
    const txt = (a.textContent || '').trim();
    if (href && href !== '#' && !txt.includes(href)) {
      a.textContent = txt ? (txt + ': ' + href) : href;
    }
  });
  const blockSelector = 'h1,h2,h3,h4,p,li,blockquote,div';
  const blocks = [];
  root.querySelectorAll(blockSelector).forEach(el => {
    if (el.tagName.toLowerCase() === 'button') return;       // skip download CTA
    if (el.querySelector(blockSelector)) return;             // skip wrappers; keep leaves
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  });
  return blocks.length ? blocks.join('\n\n') : (root.textContent || '').trim();
}

async function saveTranscriptCanonical() {
  // The ONE transcript save. Fires once, at interview completion. The server
  // sends the parent their Blueprint, sends Jay the full record + feedback, and
  // de-dupes by sessionId — so this can't double-write.
  if (window.transcriptSent) return;
  window.transcriptSent = true; // set before the await so a concurrent call no-ops
  try {
    await fetch('/api/save-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: window.sessionId || '',
        parentName: window.parentName || window.parentFirstName || 'Unknown',
        parentEmail: window.parentEmail || '',
        messages: conversationHistory,
        blueprintText: window.blueprintText || '',
        blueprintHTML: window.blueprintHTML || '',
        capturedTier: window.capturedTier || '',
        capturedPattern: window.capturedPattern || '',
        feedback: window.capturedFeedback || {},
        timestamp: new Date().toISOString()
      })
    });
    console.log('Transcript saved (canonical).');
  } catch (err) {
    window.transcriptSent = false; // allow a retry on the parent's next action
    console.error('Failed to save transcript:', err);
  }
}

async function downloadBlueprint() {
  if (!window.blueprintHTML) { alert('Blueprint not yet generated.'); return; }
  const btn = document.querySelector('.download-btn');
  if (btn) { btn.textContent = 'Preparing PDF...'; btn.disabled = true; }

  const pdfDiv = document.getElementById('pdf-blueprint');
  const nameEl = document.querySelector('.blueprint-name');
  const parentName = nameEl ? nameEl.textContent : 'Family';
  // The name originates from user/model-controlled content and is interpolated
  // into an innerHTML string below — escape it to close the XSS edge case.
  const safeParentName = escapeHTML(parentName);

  pdfDiv.innerHTML = `
    <div class="pdf-header">
      <p class="pdf-eyebrow">Outsmart the System &bull; Family Money Story Interview</p>
      <p class="pdf-title">Family Money Story Blueprint</p>
      <p class="pdf-date">Prepared for ${safeParentName}</p>
    </div>
    ${convertBlueprintToPDF(window.blueprintHTML)}
    <div class="pdf-footer">Outsmart the System &mdash; outsmartthesystem.org</div>
  `;
  pdfDiv.style.display = 'block';

  const opt = {
    margin: [12, 12, 12, 12],
    filename: 'OTS-Family-Money-Story-Blueprint.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: ['css', 'legacy'] }
  };

  try { await html2pdf().set(opt).from(pdfDiv).save(); } catch(e) { console.error('PDF error:', e); }
  pdfDiv.style.display = 'none';
  if (btn) { btn.textContent = 'Download Your Blueprint as PDF'; btn.disabled = false; }
}

function convertBlueprintToPDF(html) {
  return html
    .replace(/class="blueprint-container"/g, 'style="font-family: Georgia, serif; padding: 0;"')
    .replace(/class="blueprint-title"/g, 'class="pdf-eyebrow"')
    .replace(/class="blueprint-name"/g, 'class="pdf-title"')
    .replace(/class="blueprint-date"/g, 'class="pdf-date"')
    .replace(/class="blueprint-rule"/g, 'class="pdf-rule"')
    .replace(/class="blueprint-section-header"/g, 'class="pdf-section-label"')
    .replace(/class="blueprint-body"/g, 'class="pdf-body"')
    .replace(/class="blueprint-quote"/g, 'class="pdf-quote"')
    .replace(/class="blueprint-cry-quote"/g, 'class="pdf-cry-quote"')
    .replace(/class="blueprint-signature"/g, 'class="pdf-signature"')
    .replace(/class="blueprint-vector-pivot"/g, 'class="pdf-vector-pivot"')
    .replace(/class="blueprint-cta"/g, 'class="pdf-cta"')
    .replace(/class="blueprint-cta-heading"/g, 'class="pdf-section-label"')
    .replace(/<button class="download-btn"[^>]*>.*?<\/button>/gs, '');
}

function startSession() {
  // Guard against double-starts (double Enter press or double-click on Begin).
  if (window.sessionStarted) return;

  const nameInput = document.getElementById('inputName');
  const emailInput = document.getElementById('inputEmail');
  const nameError = document.getElementById('nameError');
  const emailError = document.getElementById('emailError');
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();

  // Reset any prior validation state before re-checking.
  if (nameError) nameError.classList.remove('visible');
  if (emailError) emailError.classList.remove('visible');
  nameInput.style.borderBottomColor = '';
  emailInput.style.borderBottomColor = '';

  if (!name) {
    nameInput.focus();
    nameInput.style.borderBottomColor = '#d4a574';
    if (nameError) nameError.classList.add('visible');
    return;
  }

  // The Blueprint is delivered by email — a missing or malformed address means
  // 35-45 minutes of work with no deliverable, so require a plausible email.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    emailInput.focus();
    emailInput.style.borderBottomColor = '#d4a574';
    if (emailError) emailError.classList.add('visible');
    return;
  }

  // Privacy consent (audit Critical 7): the parent decides whether sensitive
  // interview state is written to this device. Default is OFF — saveSession()
  // no-ops unless this is true.
  const consentBox = document.getElementById('inputConsent');
  window.saveConsent = !!(consentBox && consentBox.checked);

  window.sessionStarted = true;

  // GA4 funnel event: the parent passed name+email validation and is starting
  // the interview. Fires once per session start; carries UTM attribution.
  if (window.otsTrack) otsTrack('interview_start');

  const beginBtn = document.getElementById('beginButton');
  if (beginBtn) { beginBtn.disabled = true; beginBtn.textContent = 'Beginning…'; }

  window.parentName = name;
  window.parentEmail = email;
  // Surface the "clear my saved interview" control once a session is underway,
  // but only if the parent opted into on-device saving.
  if (window.saveConsent) {
    const clearBtn = document.getElementById('clearSavedBtn');
    if (clearBtn) clearBtn.hidden = false;
  }

  document.getElementById('chat-heading').textContent = name + "'s Interview";
  document.getElementById('intake-screen').style.display = 'none';
  const chatScreen = document.getElementById('chat-screen');
  chatScreen.style.display = 'flex';

  const opening = "You want your kids ready for real life, not just good at school. School can teach academics. It does not reliably teach money, responsibility, or judgment under pressure.\n\nIf you've ever thought <em>\"my kids are smart, but I'm not sure they're ready for real life\"</em> \u2014 this interview is for you. Real change in a family doesn't start with the kid. It starts with the money story the parent is living.\n\nThis is the Family Money Story Interview, the front door to Outsmart the System, run by Jay Bhakta. In the next 35 to 45 minutes, you'll see the money pattern you inherited, what your kids are absorbing, and where the work begins. By the end, you'll have a custom Blueprint and a clear next step. Jay personally reviews each interview.\n\nThis is deep work, not budgeting tips. There are no right answers. You can skip any question. You can pause anytime.\n\nFind a quiet room. Phone away. Do this alone \u2014 you can talk to your spouse after.\n\nLet's start simple. Who is under your roof right now? First names, ages, and one sentence about each child that only a parent would know.";

  conversationHistory.push({ role: 'user', content: 'My name is ' + name + '.' });
  conversationHistory.push({ role: 'assistant', content: opening });

  // Store the parent's name globally. It's sent to the server in the request
  // metadata, where the prompt's "[PARENT FIRST NAME]" placeholder is filled in
  // (the substitution itself now happens server-side in interview.js).
  window.parentFirstName = name;

  // Generate a fresh session ID and save initial state so the parent can recover
  // if they refresh, lose connection, or accidentally close the tab.
  window.sessionId = generateSessionId();
  saveSession();

  renderAssistantMessage(opening);
  // Override the scrollToBottom that just fired in renderAssistantMessage().
  // On the very first render, we want the parent to see the TOP of the opening
  // message — not the bottom of it. Subsequent messages keep using scrollToBottom.
  setTimeout(scrollToTop, 50);
  updateProgress();
  document.getElementById('userInput').focus();
}

// Button click handlers are wired here (not via inline onclick attributes in
// the HTML) so the Content Security Policy can forbid inline scripts.
document.getElementById('beginButton').addEventListener('click', startSession);
document.getElementById('sendButton').addEventListener('click', sendMessage);

const clearSavedBtn = document.getElementById('clearSavedBtn');
if (clearSavedBtn) {
  clearSavedBtn.addEventListener('click', function() {
    if (window.confirm('Clear your saved interview from this device? This cannot be undone.')) {
      clearSession();
      window.saveConsent = false;
      clearSavedBtn.hidden = true;
      addMessage('Your saved interview has been cleared from this device.', 'thinking');
    }
  });
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    const intake = document.getElementById('intake-screen');
    if (intake && intake.style.display !== 'none' && !window.resumeCardVisible) {
      startSession();
    }
  }
});

document.getElementById('userInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

document.getElementById('userInput').addEventListener('input', function() {
  autoResize(this);
});

window.onload = function() {
  // Check for a resumable session from a previous visit. If one exists
  // (within 24 hours, not yet completed), offer the parent the choice
  // to resume where they left off or start fresh. Most parents won't
  // see this prompt — it only fires after a refresh, crash, or tab close
  // mid-interview.
  const savedSession = loadSession();
  if (savedSession && savedSession.conversationHistory && savedSession.conversationHistory.length > 2) {
    // Only offer resume if there's meaningful progress (more than the
    // initial seed turns). Show a styled in-page card instead of a native
    // browser dialog — same logic, brand-worthy presentation.
    const hoursAgo = Math.round((Date.now() - new Date(savedSession.savedAt).getTime()) / (1000 * 60 * 60));
    const timeAgo = hoursAgo < 1 ? 'a few minutes ago' : (hoursAgo === 1 ? 'about an hour ago' : 'about ' + hoursAgo + ' hours ago');
    showResumeCard(savedSession, timeAgo);
    return;
  }

  document.getElementById('inputName').focus();
};

function showResumeCard(savedSession, timeAgo) {
  const slot = document.getElementById('resume-slot');
  if (!slot) {
    // Markup missing (shouldn't happen) — fall back to the native dialog so
    // the parent never loses access to their saved progress.
    if (window.confirm('Pick up where you left off?')) { resumeSession(savedSession); }
    else { clearSession(); }
    return;
  }

  // While the card is visible, the global Enter handler must not start a
  // fresh session underneath it.
  window.resumeCardVisible = true;

  const card = document.createElement('div');
  card.className = 'resume-card';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'resume-eyebrow';
  eyebrow.textContent = 'Welcome back';

  const msg = document.createElement('p');
  // textContent (not innerHTML) — the saved name is user-supplied input.
  msg.textContent = 'You started this interview ' + timeAgo + ' as ' +
    savedSession.parentFirstName + '. Your answers are saved — pick up right where you left off.';

  const actions = document.createElement('div');
  actions.className = 'resume-actions';

  const yes = document.createElement('button');
  yes.className = 'resume-yes';
  yes.textContent = 'Resume interview';
  yes.onclick = function() {
    window.resumeCardVisible = false;
    card.remove();
    resumeSession(savedSession);
  };

  const no = document.createElement('button');
  no.className = 'resume-no';
  no.textContent = 'Start over';
  no.onclick = function() {
    window.resumeCardVisible = false;
    clearSession();
    card.remove();
    document.getElementById('inputName').focus();
  };

  actions.appendChild(yes);
  actions.appendChild(no);
  card.appendChild(eyebrow);
  card.appendChild(msg);
  card.appendChild(actions);
  slot.appendChild(card);
}

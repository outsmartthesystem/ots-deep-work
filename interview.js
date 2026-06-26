// ─────────────────────────────────────────────────────────────────────────────
// SERVER-OWNED INTERVIEW LOGIC
// ─────────────────────────────────────────────────────────────────────────────
// The system prompt, the per-turn "internal note", the model choice, and the
// token budget all live here — on the server — instead of in the browser.
//
// Why this moved off the client (audit Critical 1):
//   - The full prompt used to ship inside chat.js, so the entire interview
//     design was public. It now lives in prompts/*.md, read at startup and
//     never sent to the browser.
//   - /api/chat used to forward whatever `system`, `model`, and `max_tokens`
//     the browser supplied. The browser can no longer set any of those. It
//     sends only the conversation messages plus a small, validated metadata
//     object; everything that controls the Anthropic call is decided here.
//
// The browser keeps a thin display/state wrapper (rendering, resume, feedback
// capture for the parent's typed answers). It cannot change the prompt, the
// model, or the token ceiling.

const fs = require('fs');
const path = require('path');
const shared = require('./shared');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'interview_system.md'), 'utf8');
const NOTE_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompts', 'interview_note.md'), 'utf8');

const MODEL_INTERVIEW = 'claude-sonnet-4-6';
const MODEL_FAST = 'claude-haiku-4-5-20251001';

// Hard ceiling regardless of what any phase asks for.
const MAX_TOKENS_CEILING = 8000;

function todayString() {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function buildSystemPrompt({ parentFirstName, captured } = {}) {
  const today = todayString();
  let prompt = SYSTEM_PROMPT
    .replace(/\[Today's date\]/g, today)
    .replace(/\[TODAY'S DATE\]/g, today);

  if (parentFirstName) {
    prompt = prompt.replace(/\[PARENT FIRST NAME\]/g, parentFirstName);
  }

  const c = captured || {};
  const subs = {
    '[F1_SCORE]': c.F1 || '[not yet captured]',
    '[F2_SCORE]': c.F2 || '[not yet captured]',
    '[F3_SCORE]': c.F3 || '[not yet captured]',
    '[F4_SCORE]': c.F4 || '[not yet captured]',
    '[F5_ANSWER]': c.F5 || '[not yet captured]',
    '[F6_ANSWER]': c.F6 || '[not yet captured]',
    '[PATTERN_PICKED]': c.pattern || '[not yet captured]',
    '[TIER_DETERMINED]': c.tier || '[not yet captured]',
  };
  Object.keys(subs).forEach((placeholder) => {
    const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    prompt = prompt.replace(new RegExp(escaped, 'g'), subs[placeholder]);
  });

  return prompt;
}

function buildInternalNote(currentQ, nextQ) {
  return NOTE_TEMPLATE
    .replace('{{currentQ}}', String(currentQ))
    .replace('{{nextQ}}', String(nextQ));
}

// Turn the validated client request into the exact body posted to Anthropic.
// Returns { model, max_tokens, system, messages }.
function prepareChatRequest({ messages, meta }) {
  const m = meta || {};
  const blueprintDelivered = !!m.blueprintDelivered;
  const parentFirstName = m.parentFirstName ? String(m.parentFirstName) : '';
  const captured = m.captured || {};

  const assistantTurns = messages.filter((x) => x.role === 'assistant').length;

  // Model + token budget are decided here, not by the browser.
  const lastUser = [...messages].reverse().find((x) => x.role === 'user');
  const lastUserText = lastUser ? String(lastUser.content) : '';
  const blueprintIncoming = shared.isBlueprintTrigger(lastUserText);
  const lateInterview = assistantTurns >= 18;

  let model;
  let maxTokens;
  if (blueprintDelivered) {
    model = MODEL_FAST;        // post-Blueprint feedback Q&A — fast + cheap
    maxTokens = 1500;
  } else if (blueprintIncoming || lateInterview) {
    model = MODEL_INTERVIEW;   // Blueprint can be long; give it room
    maxTokens = 6000;
  } else {
    model = MODEL_INTERVIEW;   // conversational turn — keep responses tight
    maxTokens = 1200;
  }
  maxTokens = Math.min(maxTokens, MAX_TOKENS_CEILING);

  let outMessages;
  if (blueprintDelivered) {
    // After the Blueprint, only the last few turns matter for the feedback Q&A.
    outMessages = messages.slice(-6).map((x) => ({ role: x.role, content: x.content }));
  } else {
    outMessages = messages.map((x) => ({ role: x.role, content: x.content }));
    // Anchor the model to the numbered question by injecting the internal note
    // into the most recent parent message. Invisible to the parent; the browser
    // only ever stores/sends the clean text.
    const currentQ = shared.estimateQuestionFromAssistantCount(assistantTurns);
    const nextQ = Math.min(currentQ + 1, 27);
    const note = buildInternalNote(currentQ, nextQ);
    for (let i = outMessages.length - 1; i >= 0; i--) {
      if (outMessages[i].role === 'user') {
        outMessages[i] = { role: 'user', content: note + '\n\n' + outMessages[i].content };
        break;
      }
    }
  }

  return {
    model,
    max_tokens: maxTokens,
    system: buildSystemPrompt({ parentFirstName, captured }),
    messages: outMessages,
  };
}

module.exports = {
  prepareChatRequest,
  buildSystemPrompt,
  buildInternalNote,
  todayString,
  MODEL_INTERVIEW,
  MODEL_FAST,
};

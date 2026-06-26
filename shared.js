// ─────────────────────────────────────────────────────────────────────────────
// SHARED PURE LOGIC
// ─────────────────────────────────────────────────────────────────────────────
// DOM-free, side-effect-free helpers used by BOTH the browser (chat.js) and the
// Node server (interview.js / server.js), and exercised directly by the Jest
// suite. Keeping them here — instead of duplicated in client and server — means
// the interview's completion/blueprint/feedback detection has exactly one
// definition and one set of tests.
//
// Loads as a global in the browser (functions become window.* so chat.js can
// call them by bare name) and as a CommonJS module under Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    Object.keys(api).forEach((k) => { window[k] = api[k]; });
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The sentinel the model emits when the interview is complete. The wrapper
  // detects it, strips it from the displayed message, and fires the one
  // canonical transcript save.
  const COMPLETION_SENTINEL = '[INTERVIEW_COMPLETE]';

  function isInterviewComplete(assistantMessage) {
    // Sentinel-only detection. If the model fails to emit the sentinel, no save
    // fires — a visible, recoverable failure rather than a silent blank-data one.
    return typeof assistantMessage === 'string' && assistantMessage.includes(COMPLETION_SENTINEL);
  }

  function stripSentinel(message) {
    return String(message).replace(COMPLETION_SENTINEL, '').trim();
  }

  function stripFeedbackBlockForDisplay(message) {
    // Remove the internal "FEEDBACK FOR JAY" block from the parent's visible
    // chat while leaving the closing message intact. The full block stays in the
    // stored history (so Jay's email is complete) — this only affects display.
    message = String(message);
    const feedbackStart = message.search(/\*?\*?FEEDBACK FOR JAY\b/i);
    if (feedbackStart === -1) {
      return message; // no block present, nothing to strip
    }
    const closingStart = message.indexOf("That's everything");
    if (closingStart === -1 || closingStart <= feedbackStart) {
      // No closing after the block (or impossible ordering) — strip from the
      // block onward to be safe.
      return message.substring(0, feedbackStart).trim();
    }
    const before = message.substring(0, feedbackStart).trim();
    const after = message.substring(closingStart).trim();
    return (before ? before + '\n\n' : '') + after;
  }

  function isBlueprintTrigger(userText) {
    const lower = String(userText).toLowerCase().trim();
    // Explicit wrap-up signals only. 'no' is intentionally excluded — it's the
    // most common answer to Q22 (the omit-anything check) and used to fire false
    // Blueprint generation.
    const explicitTriggers = ['wrap it up', 'wrap up', 'wrapup', "i'm done", 'im done', 'ready', 'finalize', 'go ahead'];
    return explicitTriggers.some((t) => lower === t || lower === t + '.' || lower.startsWith(t + ' ') || lower.endsWith(' ' + t));
  }

  function estimateQuestionFromAssistantCount(assistantTurns) {
    // Subtract 1 for the opening message; clamp to the 22-question spine.
    const estimate = Math.max(1, assistantTurns - 1);
    return Math.min(estimate, 22);
  }

  function classifyFeedbackQuestion(assistantMessage) {
    // Returns 'F1'..'F6' if the assistant message is asking that feedback
    // question, otherwise null. Phrases are distinctive — they appear only in
    // the intended question. Pure: callers apply the result to their own state.
    const msg = String(assistantMessage).toLowerCase();
    if (msg.includes('in the first 2 minutes') && msg.includes('how safe')) return 'F1';
    if (msg.includes('how clear did you feel about what to do next')) return 'F2';
    if (msg.includes('how custom did the blueprint feel')) return 'F3';
    if (msg.includes('likely are you to book the call') ||
        msg.includes('come back to this blueprint in the next 90 days') ||
        (msg.includes('if a friend asked you about this experience') && msg.includes('would you tell them'))) return 'F4';
    if (msg.includes('single moment') && msg.includes('genuinely landed')) return 'F5';
    if (msg.includes('felt off') && (msg.includes('generic') || msg.includes('robotic'))) return 'F6';
    return null;
  }

  function classifyPatternQuestion(assistantMessage) {
    // True when the assistant is asking the parent to pick a pattern (Q12) or,
    // after the skepticism move, to name their own rule.
    const msg = String(assistantMessage).toLowerCase();
    return msg.includes('which of these patterns feels closest') ||
           msg.includes('which of these feels closest to you') ||
           msg.includes("what is the rule that's actually running you");
  }

  function escapeHTML(value) {
    // Escape user/model-controlled text before interpolating into an HTML string
    // (used for the PDF blueprint header, which builds innerHTML).
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function sanitizeBlueprintHTML(html) {
    // Strict allowlist sanitizer for Blueprint output. The Blueprint uses a
    // known set of tags and attributes — anything outside that set is removed.
    // This protects against the model being coaxed into emitting unexpected
    // markup, and against any future Blueprint template changes that might
    // introduce risk. DOM-coupled (uses `document`) but only when CALLED, so it
    // is safe to import under Node; tests exercise it under jsdom.

    const allowedTags = new Set([
      'div', 'p', 'h1', 'h2', 'h3', 'h4',
      'em', 'strong', 'b', 'i', 'br', 'hr',
      'ul', 'ol', 'li', 'blockquote', 'span',
      'button', 'a', // button is for the PDF download; a is for booking link.
    ]);
    const allowedAttributes = new Set(['class', 'style', 'href', 'target', 'rel', 'data-action']);
    const allowedStyleProperties = new Set([
      'color', 'background-color', 'font-style', 'font-weight',
      'text-align', 'margin', 'padding', 'opacity',
    ]);

    // Parse the HTML in a document fragment so we can walk and filter it.
    const template = document.createElement('template');
    template.innerHTML = html;

    function clean(node) {
      const children = Array.from(node.children);
      children.forEach((child) => {
        const tag = child.tagName.toLowerCase();

        if (!allowedTags.has(tag)) {
          // Replace disallowed tag with its text content. This neutralizes
          // <script>, <iframe>, <img onerror=...>, etc., while preserving
          // any text the model wrote inside them.
          const text = document.createTextNode(child.textContent);
          node.replaceChild(text, child);
          return;
        }

        // Filter attributes to the allowlist.
        const attrs = Array.from(child.attributes);
        attrs.forEach((attr) => {
          if (!allowedAttributes.has(attr.name.toLowerCase())) {
            child.removeAttribute(attr.name);
          }
        });

        // For style attribute, filter individual properties to the allowlist.
        if (child.hasAttribute('style')) {
          const style = child.getAttribute('style');
          const safeStyles = style.split(';')
            .map((s) => s.trim())
            .filter((s) => {
              const [prop] = s.split(':').map((x) => x.trim().toLowerCase());
              return prop && allowedStyleProperties.has(prop);
            })
            .join('; ');
          if (safeStyles) {
            child.setAttribute('style', safeStyles);
          } else {
            child.removeAttribute('style');
          }
        }

        // For href attribute, only allow http://, https://, mailto:, #, empty.
        // javascript: URLs would re-open the XSS surface — strip them.
        if (child.hasAttribute('href')) {
          const href = child.getAttribute('href').trim().toLowerCase();
          const safe = href.startsWith('http://') || href.startsWith('https://') ||
                       href.startsWith('mailto:') || href.startsWith('#') || href === '';
          if (!safe) {
            child.removeAttribute('href');
          }
        }

        clean(child);
      });
    }

    clean(template.content);
    return template.innerHTML;
  }

  return {
    COMPLETION_SENTINEL,
    isInterviewComplete,
    stripSentinel,
    stripFeedbackBlockForDisplay,
    isBlueprintTrigger,
    estimateQuestionFromAssistantCount,
    classifyFeedbackQuestion,
    classifyPatternQuestion,
    escapeHTML,
    sanitizeBlueprintHTML,
  };
});

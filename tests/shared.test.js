const s = require('../shared');

describe('isInterviewComplete / stripSentinel', () => {
  test('detects the sentinel only when present', () => {
    expect(s.isInterviewComplete('all done [INTERVIEW_COMPLETE]')).toBe(true);
    expect(s.isInterviewComplete('still going')).toBe(false);
    expect(s.isInterviewComplete('')).toBe(false);
    expect(s.isInterviewComplete(null)).toBe(false);
  });

  test('strips the sentinel and trims', () => {
    expect(s.stripSentinel("That's everything.\n\n[INTERVIEW_COMPLETE]")).toBe("That's everything.");
    expect(s.stripSentinel('no sentinel here')).toBe('no sentinel here');
  });
});

describe('stripFeedbackBlockForDisplay', () => {
  test('removes the FEEDBACK FOR JAY block but keeps preamble + closing', () => {
    const msg = [
      'Here is the closing reflection.',
      '',
      '**FEEDBACK FOR JAY — Sam — June 26, 2026**',
      'F1: 9',
      'Internal note: high engagement.',
      '',
      "That's everything. Your Blueprint and your feedback are being sent to Jay now.",
    ].join('\n');
    const out = s.stripFeedbackBlockForDisplay(msg);
    expect(out).toContain('Here is the closing reflection.');
    expect(out).toContain("That's everything.");
    expect(out).not.toContain('FEEDBACK FOR JAY');
    expect(out).not.toContain('Internal note');
  });

  test('returns message unchanged when no block present', () => {
    expect(s.stripFeedbackBlockForDisplay('just a normal turn')).toBe('just a normal turn');
  });

  test('strips from block onward when no closing message follows', () => {
    const msg = 'preamble\n\nFEEDBACK FOR JAY\nF1: 8';
    const out = s.stripFeedbackBlockForDisplay(msg);
    expect(out).toBe('preamble');
  });
});

describe('isBlueprintTrigger', () => {
  test('matches explicit wrap-up phrases', () => {
    ['wrap it up', 'WRAP UP', "I'm done", 'go ahead', 'ready', 'finalize'].forEach((t) => {
      expect(s.isBlueprintTrigger(t)).toBe(true);
    });
  });

  test('does NOT match "no" or normal answers (Q22 false-positive guard)', () => {
    ['no', 'not really', 'my daughter is 14', 'I am ready to talk about my father'].forEach((t) => {
      expect(s.isBlueprintTrigger(t)).toBe(false);
    });
  });
});

describe('classifyFeedbackQuestion', () => {
  test('maps distinctive phrases to F1-F6', () => {
    expect(s.classifyFeedbackQuestion('In the first 2 minutes, how safe did you feel?')).toBe('F1');
    expect(s.classifyFeedbackQuestion('How clear did you feel about what to do next?')).toBe('F2');
    expect(s.classifyFeedbackQuestion('How custom did the Blueprint feel?')).toBe('F3');
    expect(s.classifyFeedbackQuestion('How likely are you to book the call?')).toBe('F4');
    expect(s.classifyFeedbackQuestion('Was there a single moment that genuinely landed?')).toBe('F5');
    expect(s.classifyFeedbackQuestion('Anything that felt off, generic, or robotic?')).toBe('F6');
  });

  test('returns null for ordinary turns', () => {
    expect(s.classifyFeedbackQuestion('Who is under your roof?')).toBeNull();
  });
});

describe('classifyPatternQuestion', () => {
  test('detects the Q12 pattern-pick and the skepticism re-ask', () => {
    expect(s.classifyPatternQuestion('Which of these patterns feels closest to you — and why?')).toBe(true);
    expect(s.classifyPatternQuestion("What is the rule that's actually running you?")).toBe(true);
    expect(s.classifyPatternQuestion('Tell me about your childhood home.')).toBe(false);
  });
});

describe('escapeHTML', () => {
  test('escapes the dangerous characters', () => {
    expect(s.escapeHTML('<img src=x onerror="alert(1)">'))
      .toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(s.escapeHTML("O'Brien & Sons")).toBe('O&#39;Brien &amp; Sons');
  });
});

describe('estimateQuestionFromAssistantCount', () => {
  test('subtracts the opening and clamps to [1, 22]', () => {
    expect(s.estimateQuestionFromAssistantCount(0)).toBe(1);
    expect(s.estimateQuestionFromAssistantCount(1)).toBe(1);
    expect(s.estimateQuestionFromAssistantCount(8)).toBe(7);
    expect(s.estimateQuestionFromAssistantCount(40)).toBe(22);
  });
});

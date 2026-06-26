const interview = require('../interview');

describe('buildSystemPrompt', () => {
  test('substitutes name + captured values and leaves no known placeholders', () => {
    const prompt = interview.buildSystemPrompt({
      parentFirstName: 'Sam',
      captured: { F1: '9', F2: '8', F3: '7', F4: '6', F5: 'the room', F6: 'nothing', pattern: 'Scarcity Default', tier: '1' },
    });
    expect(prompt).toContain('Sam');
    expect(prompt).not.toContain('[PARENT FIRST NAME]');
    expect(prompt).not.toContain('[F1_SCORE]');
    expect(prompt).not.toContain('[TIER_DETERMINED]');
    expect(prompt).not.toContain("[Today's date]");
    expect(prompt).not.toContain("[TODAY'S DATE]");
    expect(prompt).toContain('Scarcity Default');
  });

  test('uses "[not yet captured]" before answers exist', () => {
    const prompt = interview.buildSystemPrompt({ parentFirstName: 'Sam', captured: {} });
    expect(prompt).toContain('[not yet captured]');
  });
});

describe('buildInternalNote', () => {
  test('fills the question tokens', () => {
    const note = interview.buildInternalNote(7, 8);
    expect(note).toContain('You are roughly on Q7 of 22');
    expect(note).toContain('move to Q8');
    expect(note).not.toContain('{{currentQ}}');
    expect(note).not.toContain('{{nextQ}}');
  });
});

function convo(assistantTurns, lastUser = 'a normal answer') {
  // Build a messages array with N assistant turns, ending on a user message.
  const msgs = [];
  for (let i = 0; i < assistantTurns; i++) {
    msgs.push({ role: 'assistant', content: 'Q' + (i + 1) });
    msgs.push({ role: 'user', content: 'A' + (i + 1) });
  }
  msgs.push({ role: 'user', content: lastUser });
  return msgs;
}

describe('prepareChatRequest — model + token budget (server-owned)', () => {
  test('conversational turn: sonnet, 1200 tokens, note injected into last user msg', () => {
    const req = interview.prepareChatRequest({ messages: convo(5), meta: { blueprintDelivered: false } });
    expect(req.model).toBe(interview.MODEL_INTERVIEW);
    expect(req.max_tokens).toBe(1200);
    const last = req.messages[req.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('[Internal note for the interviewer:');
    expect(last.content).toContain('a normal answer'); // original text preserved after the note
  });

  test('late interview (>=18 assistant turns) bumps to 6000 tokens', () => {
    const req = interview.prepareChatRequest({ messages: convo(18), meta: { blueprintDelivered: false } });
    expect(req.max_tokens).toBe(6000);
  });

  test('explicit "wrap it up" trigger bumps to 6000 tokens', () => {
    const req = interview.prepareChatRequest({ messages: convo(6, 'wrap it up'), meta: { blueprintDelivered: false } });
    expect(req.max_tokens).toBe(6000);
  });

  test('post-Blueprint feedback: fast model, 1500 tokens, last 6 msgs, NO note', () => {
    const req = interview.prepareChatRequest({ messages: convo(24), meta: { blueprintDelivered: true } });
    expect(req.model).toBe(interview.MODEL_FAST);
    expect(req.max_tokens).toBe(1500);
    expect(req.messages.length).toBeLessThanOrEqual(6);
    expect(req.messages.every((m) => !m.content.includes('[Internal note'))).toBe(true);
  });

  test('the outgoing system prompt carries no leaked placeholders', () => {
    const req = interview.prepareChatRequest({ messages: convo(3), meta: { parentFirstName: 'Sam' } });
    expect(req.system).not.toContain('[PARENT FIRST NAME]');
    expect(req.system).not.toContain('[F1_SCORE]');
  });
});

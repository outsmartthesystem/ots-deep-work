const SYSTEM_PROMPT = `PASTE YOUR FULL SYSTEM PROMPT HERE`;

const conversationHistory = [];

async function sendMessage() {
  const input = document.getElementById('userInput');
  const sendButton = document.getElementById('sendButton');
  const userText = input.value.trim();

  if (!userText || sendButton.disabled) return;

  addMessage(userText, 'user');
  input.value = '';
  sendButton.disabled = true;

  const thinking = addMessage('...', 'thinking');

  conversationHistory.push({
    role: 'user',
    content: userText
  });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'YOUR_API_KEY_HERE',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: conversationHistory
      })
    });

    const data = await response.json();
    const assistantMessage = data.content[0].text;

    thinking.remove();

    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    addMessage(assistantMessage, 'agent');

  } catch (error) {
    thinking.remove();
    addMessage('Something went wrong. Please try again.', 'agent');
    console.error(error);
  }

  sendButton.disabled = false;
  scrollToBottom();
}

function addMessage(text, type) {
  const messages = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.innerHTML = text.replace(/\n/g, '<br>');
  messages.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  const chatWindow = document.getElementById('chatWindow');
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function startInterview() {
  const opening = `Before we begin, three quick things. You can skip any question. You can pause anytime. You can stop whenever you want. There are no good answers and no bad answers. The only thing that fails this interview is performing.

If at any point your eyes well up or you need a minute, that's a signal we're in exactly the right place. You don't have to manage that for me. Just stay with it.

Let's start with something easy. Tell me who is under your roof right now. Names, ages, and one sentence about each child that only a parent would know.`;

  conversationHistory.push({
    role: 'assistant',
    content: opening
  });

  addMessage(opening, 'agent');
}

document.getElementById('userInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

window.onload = startInterview;

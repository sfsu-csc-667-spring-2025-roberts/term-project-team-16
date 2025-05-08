const socket = io();

const chatForm     = document.getElementById('chat-form');
const chatInput    = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');

chatForm.addEventListener('submit', e => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  fetch('/chat/0', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  chatInput.value = '';
});

socket.on('chat-message-0', data => {
  const el = document.createElement('div');
  el.textContent = `${data.sender.username}: ${data.message}`;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

window.socket       = socket;
window.chatMessages = chatMessages;
window.chatInput    = chatInput;

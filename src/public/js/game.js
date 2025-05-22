const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
    transports: ['websocket', 'polling'],
    path: '/socket.io',
    autoConnect: true,
    timeout: 10000
});

// Get game ID from the URL
const pathParts = window.location.pathname.split('/');
const gameId = pathParts[pathParts.length - 1];

// DOM elements
const chatForm = document.getElementById('game-chat-form');
const chatInput = document.getElementById('game-chat-input');
const chatMessages = document.getElementById('game-chat-messages');
const submitButton = chatForm?.querySelector('button[type="submit"]');

// Join game room when connecting
socket.on('connect', () => {
    console.log('Connected to game server');
    socket.emit('game:join-room', { gameId }, (response) => {
        if (response?.error) {
            console.error('Error joining game room:', response.error);
            handleConnectionError('Failed to join game room');
            return;
        }
        console.log('Successfully joined game room');
        
        // Load message history for this game
        socket.emit('game:loadMessages', { gameId }, (response) => {
            if (response?.error) {
                console.error('Error loading messages:', response.error);
                handleConnectionError('Failed to load message history');
            }
        });
    });
});

// Handle sending messages
chatForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    
    try {
        submitButton.disabled = true; // Prevent double-submit
        socket.emit('game:sendMessage', { gameId, message }, (ack) => {
            if (ack?.error) {
                console.error('Message failed to send:', ack.error);
                handleConnectionError(ack.error);
                submitButton.disabled = false;
                return;
            }
            chatInput.value = '';
            submitButton.disabled = false;
        });
    } catch (err) {
        console.error('Error sending message:', err);
        handleConnectionError('Failed to send message');
        submitButton.disabled = false;
    }
});

// Handle receiving messages
socket.on('game:newMessage', data => {
    appendMessage(data);
});

// Handle loading chat history
socket.on('game:loadMessages', messages => {
    chatMessages.innerHTML = '';
    messages.forEach(msg => appendMessage(msg));
});

function appendMessage(data) {
    const el = document.createElement('li');
    el.className = 'chat-message';
    const username = data.username ? escapeHtml(data.username) : 'Anonymous';
    const content = escapeHtml(data.content);
    el.innerHTML = `<strong>${username}</strong>: ${content} <small>${new Date(data.created_at).toLocaleTimeString()}</small>`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function handleConnectionError(message) {
    const errorMsg = document.createElement('li');
    errorMsg.className = 'error-message';
    errorMsg.textContent = message;
    chatMessages.appendChild(errorMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Helper function to prevent XSS
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Handle disconnection cleanup
window.addEventListener('beforeunload', () => {
    socket.emit('game:leave-room', { gameId });
});

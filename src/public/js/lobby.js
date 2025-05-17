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

// Enhanced connection event handlers with debugging
socket.on('connect', () => {
    console.log('Connected to server with transport:', socket.io.engine.transport.name);
    document.getElementById('connection-status')?.classList.remove('disconnected');
    clearConnectionError();
});

socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    document.getElementById('connection-status')?.classList.add('disconnected');
    handleConnectionError('Connection lost. Trying to reconnect...');
});

socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    handleConnectionError('Connection error. Please check your internet connection.');
});

socket.on('error', (error) => {
    console.error('Socket error:', error);
    handleConnectionError('An error occurred. Trying to reconnect...');
});

// Handle user presence
socket.on('lobby:userJoined', (data) => {
    appendSystemMessage(`${data.username} joined the lobby`);
});

socket.on('lobby:userLeft', (data) => {
    appendSystemMessage(`${data.username} left the lobby`);
});

function handleConnectionError(message) {
    const messages = document.getElementById('lobby-chat-messages');
    if (messages) {
        const errorMsg = document.createElement('li');
        errorMsg.className = 'error-message';
        errorMsg.textContent = message;
        messages.appendChild(errorMsg);
        messages.scrollTop = messages.scrollHeight;
    }
}

function clearConnectionError() {
    const messages = document.getElementById('lobby-chat-messages');
    if (messages) {
        const errorMessages = messages.getElementsByClassName('error-message');
        Array.from(errorMessages).forEach(msg => msg.remove());
    }
}

function appendSystemMessage(text) {
    const messages = document.getElementById('lobby-chat-messages');
    if (messages) {
        const msg = document.createElement('li');
        msg.className = 'system-message';
        msg.textContent = text;
        messages.appendChild(msg);
        messages.scrollTop = messages.scrollHeight;
    }
}

// Handle chat functionality
const chatForm = document.getElementById('lobby-message-form');
const chatInput = document.getElementById('lobby-message-input');
const chatMessages = document.getElementById('lobby-chat-messages');
const submitButton = chatForm?.querySelector('button[type="submit"]');

// Check authentication status
socket.on('auth:status', (data) => {
    if (chatInput && submitButton) {
        if (!data.authenticated) {
            chatInput.placeholder = 'Please login to send messages...';
            chatInput.disabled = true;
            submitButton.disabled = true;
        } else {
            chatInput.placeholder = 'Type your message...';
            chatInput.disabled = false;
            submitButton.disabled = false;
        }
    }
});

// Handle sending messages
chatForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    
    try {
        submitButton.disabled = true; // Prevent double-submit
        socket.emit('lobby:sendMessage', { message }, (ack) => {
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
socket.on('lobby:newMessage', data => {
    appendMessage(data);
});

// Handle loading chat history
socket.on('lobby:loadMessages', messages => {
    chatMessages.innerHTML = '';
    messages.forEach(msg => appendMessage(msg));
});

function appendMessage(data) {
    const el = document.createElement('li');
    el.className = 'chat-message';
    // Escape HTML in username and content to prevent XSS
    const username = data.username ? escapeHtml(data.username) : 'Anonymous';
    const content = escapeHtml(data.content);
    el.innerHTML = `<strong>${username}</strong>: ${content} <small>${new Date(data.created_at).toLocaleTimeString()}</small>`;
    chatMessages.appendChild(el);
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

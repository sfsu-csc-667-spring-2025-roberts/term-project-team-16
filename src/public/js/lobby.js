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
            socket.auth = { authenticated: false };
        } else {
            chatInput.placeholder = 'Type your message...';
            chatInput.disabled = false;
            submitButton.disabled = false;
            socket.auth = { 
                authenticated: true, 
                username: data.username,
                userId: data.userId 
            };
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

// Game-related functionality
const createGameBtn = document.getElementById('create-game');
const activeGamesContainer = document.getElementById('active-games');

// Game list pagination state
const gameState = {
    currentPage: 1,
    totalPages: 1
};

// Game list functions
async function fetchGames(page = 1) {
    try {
        const response = await fetch(`/games?page=${page}&limit=10`);
        const data = await response.json();
        
        const gamesGrid = document.getElementById('active-games');
        gamesGrid.innerHTML = ''; // Clear existing games
        
        data.games.forEach(game => {
            const gameElement = createGameElement(game);
            gamesGrid.appendChild(gameElement);
        });

        // Update pagination
        gameState.currentPage = data.pagination.currentPage;
        gameState.totalPages = data.pagination.totalPages;
        updatePaginationControls(data.pagination);
    } catch (error) {
        console.error('Error fetching games:', error);
    }
}

function updatePaginationControls(pagination) {
    const prevButton = document.getElementById('prev-page');
    const nextButton = document.getElementById('next-page');
    const pageInfo = document.getElementById('page-info');

    if (prevButton && nextButton && pageInfo) {
        prevButton.disabled = !pagination.hasPrevPage;
        nextButton.disabled = !pagination.hasNextPage;
        pageInfo.textContent = `Page ${pagination.currentPage} of ${pagination.totalPages}`;
    }
}

function createGameElement(game) {
    const div = document.createElement('div');
    div.className = 'game-item';
    
    // Check if current user is in the game
    const userId = socket.auth?.userId;
    const isPlayerInGame = game.players.some(p => p.user_id === userId);
    div.setAttribute('data-user-in-game', isPlayerInGame ? 'true' : 'false');
    
    div.innerHTML = `
        <div class="game-info">
            <span class="game-id">Game #${game.game_id}</span>
            <span class="player-count">${game.players.length} players</span>
            <span class="game-status ${game.state}">${game.state === 'waiting' ? 'Waiting' : 'In Progress'}</span>
        </div>
        <div class="game-actions">
            ${isPlayerInGame ? 
                `<button class="btn ${game.state === 'playing' ? 'rejoin-game' : 'join-game'}" data-game-id="${game.game_id}">
                    ${game.state === 'playing' ? 'Rejoin Game' : 'Return to Game'}
                </button>` :
                (game.state === 'waiting' ? 
                    `<button class="btn join-game" data-game-id="${game.game_id}">Join Game</button>` :
                    '<span class="game-status">In Progress</span>'
                )
            }
        </div>
    `;

    // Add join/rejoin game handler
    const actionButton = div.querySelector('.join-game, .rejoin-game');
    if (actionButton) {
        actionButton.addEventListener('click', async () => {
            const gameId = actionButton.getAttribute('data-game-id');
            if (isPlayerInGame) {
                // If player is already in the game, just navigate to it
                window.location.href = `/games/${gameId}`;
            } else {
                try {
                    const response = await fetch(`/games/${gameId}/join`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    
                    if (response.ok) {
                        window.location.href = `/games/${gameId}`;
                    } else {
                        const error = await response.json();
                        alert(error.error || 'Failed to join game');
                    }
                } catch (error) {
                    console.error('Error joining game:', error);
                    alert('Failed to join game');
                }
            }
        });
    }

    return div;
}

// Initialize pagination controls
document.getElementById('prev-page')?.addEventListener('click', () => {
    if (gameState.currentPage > 1) {
        fetchGames(gameState.currentPage - 1);
    }
});

document.getElementById('next-page')?.addEventListener('click', () => {
    if (gameState.currentPage < gameState.totalPages) {
        fetchGames(gameState.currentPage + 1);
    }
});

// Create game button handler
document.getElementById('create-game')?.addEventListener('click', async () => {
    try {
        const response = await fetch('/games', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const game = await response.json();
            window.location.href = `/games/${game.id}`;
        } else {
            console.error('Failed to create game');
        }
    } catch (error) {
        console.error('Error creating game:', error);
    }
});

// Handle game state changes
socket.on('game:stateChanged', (data) => {
    const gamesGrid = document.getElementById('active-games');
    if (!gamesGrid) return;

    // Find and update the existing game element if it exists
    const existingGame = Array.from(gamesGrid.children).find(el => {
        const button = el.querySelector('button[data-game-id]');
        return button && button.getAttribute('data-game-id') === data.gameId;
    });

    if (existingGame) {
        const gameData = {
            game_id: data.gameId,
            state: data.state,
            players: data.players
        };
        const updatedGame = createGameElement(gameData);
        existingGame.replaceWith(updatedGame);
    } else {
        // If game not found in current view, refresh the whole list
        fetchGames(gameState.currentPage);
    }
});

// Initial fetch of games
fetchGames();

// Refresh games list periodically
setInterval(() => {
    fetchGames(gameState.currentPage);
}, 30000); // Refresh every 30 seconds

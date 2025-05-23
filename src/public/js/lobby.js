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
    console.log('Auth status received:', data);
    
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
    
    // IMPORTANT: Fetch games after auth status is received
    // This ensures we have the userId when rendering game elements
    if (!gameState.hasInitialLoad) {
        console.log('Initial games fetch after auth status');
        fetchGames();
        gameState.hasInitialLoad = true;
    } else {
        // If games were already loaded, re-render them with correct auth info
        console.log('Re-rendering games with auth info');
        const currentGamesData = getCurrentGamesData();
        if (currentGamesData.length > 0) {
            rerenderCurrentGames(currentGamesData);
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
    totalPages: 1,
    hasInitialLoad: false, // Track if we've done the initial load
    currentGamesData: [] // Store current games data for re-rendering
};

// Game list functions
async function fetchGames(page = 1) {
    try {
        const response = await fetch(`/games?page=${page}&limit=10`);
        const data = await response.json();
        
        // Store games data for potential re-rendering
        gameState.currentGamesData = data.games;
        
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

// Helper function to get current games data
function getCurrentGamesData() {
    return gameState.currentGamesData || [];
}

// Helper function to re-render current games (useful when auth status changes)
function rerenderCurrentGames(gamesData) {
    const gamesGrid = document.getElementById('active-games');
    if (!gamesGrid || !gamesData || gamesData.length === 0) return;
    
    console.log('Re-rendering', gamesData.length, 'games with updated auth info');
    
    gamesGrid.innerHTML = ''; // Clear existing games
    
    gamesData.forEach(game => {
        const gameElement = createGameElement(game);
        gamesGrid.appendChild(gameElement);
    });
}

// NEW: Helper function to get currently visible game IDs
function getCurrentlyVisibleGameIds() {
    const gamesGrid = document.getElementById('active-games');
    if (!gamesGrid) return [];
    
    return Array.from(gamesGrid.children).map(gameElement => {
        const button = gameElement.querySelector('button[data-game-id]');
        return button ? button.getAttribute('data-game-id') : null;
    }).filter(Boolean);
}

// NEW: Show notification for new games when not on page 1
function showNewGameNotification() {
    showNotification('New game created! Go to page 1 to see it.', 'info');
}

// NEW: Show notification for game updates
function showGameUpdateNotification(message) {
    showNotification(message, 'info');
}

// NEW: Generic notification system
function showNotification(message, type = 'info') {
    // Remove existing notification if present
    const existing = document.querySelector('.lobby-notification');
    if (existing) {
        existing.remove();
    }
    
    const notification = document.createElement('div');
    notification.className = `lobby-notification ${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 20px;
        border-radius: 6px;
        color: white;
        font-size: 14px;
        z-index: 1000;
        cursor: pointer;
        animation: slideInFromRight 0.3s ease-out;
        ${type === 'info' ? 'background: #2196F3;' : ''}
        ${type === 'success' ? 'background: #4CAF50;' : ''}
        ${type === 'warning' ? 'background: #FF9800;' : ''}
    `;
    
    // Add CSS animation if not already present
    if (!document.querySelector('#notification-animation')) {
        const style = document.createElement('style');
        style.id = 'notification-animation';
        style.textContent = `
            @keyframes slideInFromRight {
                0% { transform: translateX(100%); opacity: 0; }
                100% { transform: translateX(0); opacity: 1; }
            }
            @keyframes slideOutToRight {
                0% { transform: translateX(0); opacity: 1; }
                100% { transform: translateX(100%); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Click to dismiss
    notification.addEventListener('click', () => {
        notification.style.animation = 'slideOutToRight 0.3s ease-in';
        setTimeout(() => notification.remove(), 300);
    });
    
    document.body.appendChild(notification);
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideOutToRight 0.3s ease-in';
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}
async function fetchLatestGames() {
    try {
        const response = await fetch(`/games?page=1&limit=10`);
        const data = await response.json();
        
        const gamesGrid = document.getElementById('active-games');
        gamesGrid.innerHTML = ''; // Clear existing games
        
        data.games.forEach(game => {
            const gameElement = createGameElement(game);
            gamesGrid.appendChild(gameElement);
        });

        // Update pagination state to page 1
        gameState.currentPage = 1;
        gameState.totalPages = data.pagination.totalPages;
        updatePaginationControls(data.pagination);
        
        // Add visual indicator that we've jumped to latest games
        showLatestGamesIndicator();
    } catch (error) {
        console.error('Error fetching latest games:', error);
    }
}

// NEW: Show a brief indicator that we've jumped to the latest games
function showLatestGamesIndicator() {
    const gamesGrid = document.getElementById('active-games');
    if (!gamesGrid) return;
    
    // Create a temporary indicator
    const indicator = document.createElement('div');
    indicator.className = 'latest-games-indicator';
    indicator.textContent = 'Showing latest games';
    indicator.style.cssText = `
        position: absolute;
        top: -30px;
        left: 50%;
        transform: translateX(-50%);
        background: #4CAF50;
        color: white;
        padding: 5px 15px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 1000;
        animation: fadeInOut 3s ease-in-out;
    `;
    
    // Add CSS animation if not already present
    if (!document.querySelector('#latest-games-animation')) {
        const style = document.createElement('style');
        style.id = 'latest-games-animation';
        style.textContent = `
            @keyframes fadeInOut {
                0% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                20% { opacity: 1; transform: translateX(-50%) translateY(0); }
                80% { opacity: 1; transform: translateX(-50%) translateY(0); }
                100% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
            }
        `;
        document.head.appendChild(style);
    }
    
    // Position the games grid relatively if not already
    if (getComputedStyle(gamesGrid).position === 'static') {
        gamesGrid.style.position = 'relative';
    }
    
    gamesGrid.appendChild(indicator);
    
    // Remove indicator after animation
    setTimeout(() => {
        if (indicator.parentNode) {
            indicator.parentNode.removeChild(indicator);
        }
    }, 3000);
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
    // Add defensive programming for auth not being available yet
    const userId = socket.auth?.userId || null;
    const isPlayerInGame = userId && game.players.some(p => p.user_id === userId);
    
    // Add debug logging to help track auth issues
    if (!userId && socket.connected) {
        console.log('Warning: Creating game element without userId. Auth status:', socket.auth);
    }
    
    div.setAttribute('data-user-in-game', isPlayerInGame ? 'true' : 'false');
    div.setAttribute('data-game-id', game.game_id); // Add for easier debugging
    
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
                (game.state === 'waiting' && userId ? 
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
        // If game not found in current view, fetch latest games to show updates
        fetchLatestGames();
    }
});

// UPDATED: Handle new game created event - smart update logic
socket.on('game:created', (data) => {
    console.log('New game created:', data);
    // If we're on page 1, refresh to show the new game
    // If we're on other pages, only refresh if the user created the game
    if (gameState.currentPage === 1) {
        fetchLatestGames();
    } else {
        // Check if current user created this game (they would be redirected anyway)
        // For other users, show a subtle notification instead of jarring page jump
        showNewGameNotification();
    }
});

// UPDATED: Handle game joined event - smart update logic
socket.on('game:joined', (data) => {
    console.log('Game joined:', data);
    // Always update if we can see the game in current view
    const currentlyVisibleGameIds = getCurrentlyVisibleGameIds();
    if (currentlyVisibleGameIds.includes(data.gameId) || gameState.currentPage === 1) {
        fetchGames(gameState.currentPage); // Refresh current page
    } else {
        showGameUpdateNotification(`Game #${data.gameId} updated`);
    }
});

// UPDATED: Handle game deleted/ended event - smart update logic
socket.on('game:ended', (data) => {
    console.log('Game ended:', data);
    // Always update current view since ended games get removed
    fetchGames(gameState.currentPage);
});


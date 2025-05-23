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

// socket debuggers
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

// user presence checks
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

// chat forms
const chatForm = document.getElementById('lobby-message-form');
const chatInput = document.getElementById('lobby-message-input');
const chatMessages = document.getElementById('lobby-chat-messages');
const submitButton = chatForm?.querySelector('button[type="submit"]');

// receiving messages
socket.on('lobby:newMessage', data => {
    appendMessage(data);
});

// loading chat history
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

// idk if this is true, but claude said this is standard to help xss
// like I can barely find anything about this being something I need to do
// this is the kind of false positive preppy bullshit LLMs lie to you about
// whatever its front end only anyways because I am never hosting this garbage
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

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

// buttons I know how to make these!!!!
const createGameBtn = document.getElementById('create-game');
const activeGamesContainer = document.getElementById('active-games');

// 
const gameState = {
    currentPage: 1,
    totalPages: 1,
    hasInitialLoad: false,  //check for page start load
    currentGamesData: [] // stores array of games so we dont kill server, I really dont know how to support this infinite number of games thing
};

// ===== HELPER FUNCTIONS FOR INCREMENTAL UPDATES =====

// Update a single game element in the DOM
function updateSingleGameElement(gameId, gameData) {
    const gameElement = document.querySelector(`[data-game-id="${gameId}"]`);
    if (!gameElement) {
        console.log(`Game ${gameId} not found in current view, skipping update`);
        return false;
    }
    
    console.log(`Updating game ${gameId} in place`);
    const updatedElement = createGameElement(gameData);
    gameElement.replaceWith(updatedElement);
    return true;
}

// Add a new game to the top of the list (for page 1 only)
function addNewGameToTop(gameData) {
    if (gameState.currentPage !== 1) {
        return false; // Don't add if not on first page
    }
    
    const gamesGrid = document.getElementById('active-games');
    if (!gamesGrid) return false;
    
    console.log(`Adding new game ${gameData.game_id || gameData.id} to top of list`);
    const gameElement = createGameElement(gameData);
    gamesGrid.insertBefore(gameElement, gamesGrid.firstChild);
    
    // Update our local games data
    gameState.currentGamesData.unshift(gameData);
    
    // Remove the last game if we're over the limit (usually 10 per page)
    const gameElements = gamesGrid.children;
    if (gameElements.length > 10) {
        gameElements[gameElements.length - 1].remove();
        gameState.currentGamesData.pop();
    }
    
    return true;
}

// Remove a game from the current view
function removeGameFromView(gameId) {
    const gameElement = document.querySelector(`[data-game-id="${gameId}"]`);
    if (!gameElement) {
        return false;
    }
    
    console.log(`Removing game ${gameId} from view`);
    gameElement.remove();
    
    // Update our local games data
    gameState.currentGamesData = gameState.currentGamesData.filter(
        game => game.game_id.toString() !== gameId.toString()
    );
    
    return true;
}

// Check if a game is currently visible
function isGameVisible(gameId) {
    return document.querySelector(`[data-game-id="${gameId}"]`) !== null;
}

// Update local game data without DOM manipulation
function updateLocalGameData(gameId, updates) {
    const gameIndex = gameState.currentGamesData.findIndex(
        game => game.game_id.toString() === gameId.toString()
    );
    
    if (gameIndex !== -1) {
        gameState.currentGamesData[gameIndex] = {
            ...gameState.currentGamesData[gameIndex],
            ...updates
        };
    }
}

function getCurrentGamesData() {
    return gameState.currentGamesData || [];
}

function getCurrentlyVisibleGameIds() {
    const gamesGrid = document.getElementById('active-games');
    if (!gamesGrid) return [];
    
    return Array.from(gamesGrid.children).map(gameElement => {
        const button = gameElement.querySelector('button[data-game-id]');
        return button ? button.getAttribute('data-game-id') : null;
    }).filter(Boolean);
}

// Game list functions
async function fetchGames(page = 1) {
    try {
        console.log(`Fetching full games list for page ${page}`);
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

        // pagination
        gameState.currentPage = data.pagination.currentPage;
        gameState.totalPages = data.pagination.totalPages;
        updatePaginationControls(data.pagination);
    } catch (error) {
        console.error('Error fetching games:', error);
        showNotification('Failed to load games', 'warning');
    }
}

// OPTIMIZED: Only fetch latest when absolutely necessary
async function fetchLatestGames() {
    // Only do this for major updates or initial loads
    console.log('Fetching latest games (full refresh)');
    await fetchGames(1);
    showLatestGamesIndicator();
}

function showLatestGamesIndicator() {
    const gamesGrid = document.getElementById('active-games');
    if (!gamesGrid) return;
    
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
    const isPlayerInGame = userId && game.players && (
        Array.isArray(game.players) ? 
        game.players.some(p => 
            typeof p === 'string' ? p === socket.auth?.username : p.user_id === userId
        ) : false
    );
    
    // Add debug logging to help track auth issues
    if (!userId && socket.connected) {
        console.log('Warning: Creating game element without userId. Auth status:', socket.auth);
    }
    
    div.setAttribute('data-user-in-game', isPlayerInGame ? 'true' : 'false');
    div.setAttribute('data-game-id', game.game_id || game.id); // Add for easier debugging
    
    // Calculate player count more safely
    const playerCount = game.players ? 
        (Array.isArray(game.players) ? game.players.length : 0) : 0;
    
    div.innerHTML = `
        <div class="game-info">
            <span class="game-id">Game #${game.game_id || game.id}</span>
            <span class="player-count">${playerCount}/4 players</span>
            <span class="game-status ${game.state}">${game.state === 'waiting' ? 'Waiting' : 'In Progress'}</span>
        </div>
        <div class="game-actions">
            ${isPlayerInGame ? 
                `<button class="btn ${game.state === 'playing' ? 'rejoin-game' : 'waiting-game'}" data-game-id="${game.game_id || game.id}">
                    ${game.state === 'playing' ? 'Rejoin Game' : 'Enter Game'}
                </button>` :
                (game.state === 'waiting' && userId && playerCount < 4 ? 
                    `<button class="btn join-game" data-game-id="${game.game_id || game.id}">Join Game</button>` :
                    `<span class="game-status">${game.state === 'waiting' ? 'Game Full' : 'In Progress'}</span>`
                )
            }
        </div>
    `;

    // Add join/rejoin game handler
    const actionButton = div.querySelector('.join-game, .rejoin-game, .waiting-game');
    if (actionButton) {
        actionButton.addEventListener('click', async () => {
            const gameId = actionButton.getAttribute('data-game-id');
            const isJoinAction = actionButton.classList.contains('join-game');
            
            try {
                actionButton.disabled = true;
                
                if (isJoinAction) {
                    // Joining a new game
                    const response = await fetch(`/games/${gameId}/join`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    
                    if (response.ok) {
                        // The socket event will update the UI
                        showNotification('Joined game successfully!', 'success');
                        // Small delay to let the socket update, then navigate
                        setTimeout(() => {
                            window.location.href = `/games/${gameId}`;
                        }, 500);
                    } else {
                        const error = await response.json();
                        showNotification(error.error || 'Failed to join game', 'warning');
                    }
                } else {
                    // If player is already in the game, just navigate to it
                    window.location.href = `/games/${gameId}`;
                }
            } catch (error) {
                console.error('Error with game action:', error);
                showNotification('Failed to perform action', 'warning');
            } finally {
                actionButton.disabled = false;
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
        const button = document.getElementById('create-game');
        if (button) button.disabled = true;
        
        const response = await fetch('/games', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const game = await response.json();
            // The socket event will handle updating the UI
            window.location.href = `/games/${game.id}`;
        } else {
            const error = await response.json();
            console.error('Failed to create game:', error);
            showNotification(error.error || 'Failed to create game', 'warning');
        }
    } catch (error) {
        console.error('Error creating game:', error);
        showNotification('Failed to create game', 'warning');
    } finally {
        const button = document.getElementById('create-game');
        if (button) button.disabled = false;
    }
});

// Enhanced notifications with better messaging
function showNewGameNotification() {
    showNotification('New game available! Go to page 1 to see it.', 'info');
}

function showGameUpdateNotification(message) {
    showNotification(message, 'info');
}

// Generic notification system
function showNotification(message, type = 'info') {
    // Remove existing notification if present
    const existing = document.querySelector('.lobby-notification');
    if (existing) {
        existing.remove();
    }
    
    const notification = document.createElement('div');
    notification.className = `lobby-notification ${type}`;
    notification.textContent = message;
    
    // Better styling
    const bgColors = {
        'info': '#2196F3',
        'success': '#4CAF50', 
        'warning': '#FF9800',
        'error': '#f44336'
    };
    
    notification.style.cssText = `
        position: fixed;
        top: 80px;
        right: 20px;
        padding: 12px 20px;
        border-radius: 8px;
        color: white;
        font-size: 14px;
        font-weight: 500;
        z-index: 10000;
        cursor: pointer;
        animation: slideInFromRight 0.3s ease-out;
        background: ${bgColors[type] || bgColors.info};
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        max-width: 300px;
        word-wrap: break-word;
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
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 300);
    });
    
    document.body.appendChild(notification);
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideOutToRight 0.3s ease-in';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 300);
        }
    }, 5000);
}

// "refresh current page" option for users who want to see all updates
function addRefreshButton() {
    const existingButton = document.getElementById('refresh-games');
    if (existingButton) return; // Already exists
    
    const pageControls = document.querySelector('.pagination-controls');
    if (!pageControls) return;
    
    const refreshButton = document.createElement('button');
    refreshButton.id = 'refresh-games';
    refreshButton.className = 'btn btn-secondary';
    refreshButton.textContent = 'Refresh';
    refreshButton.onclick = () => {
        console.log('Manual refresh requested');
        fetchGames(gameState.currentPage);
    };
    
    pageControls.appendChild(refreshButton);
}

// 
document.addEventListener('DOMContentLoaded', () => {
    addRefreshButton();
});

// Add a helper function to refresh a specific game's data
async function refreshGameData(gameId) {
    return new Promise((resolve) => {
        socket.emit('game:requestUpdate', { gameId }, (response) => {
            if (response?.success && response.game) {
                updateSingleGameElement(gameId, response.game);
                updateLocalGameData(gameId, response.game);
                resolve(true);
            } else {
                console.error('Failed to refresh game data:', response?.error);
                resolve(false);
            }
        });
    });
}

// ===== OPTIMIZED SOCKET EVENT HANDLERS =====

// auth check with optimized re-rendering
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
    
    //  initial load handling
    if (!gameState.hasInitialLoad) {
        console.log('Initial games fetch after auth status');
        fetchGames(1); // Start at page 1
        gameState.hasInitialLoad = true;
    } else {
        //  re-render existing games, don't fetch new ones
        console.log('Re-rendering existing games with updated auth info');
        if (gameState.currentGamesData.length > 0) {
            const gamesGrid = document.getElementById('active-games');
            if (gamesGrid) {
                gamesGrid.innerHTML = '';
                gameState.currentGamesData.forEach(game => {
                    const gameElement = createGameElement(game);
                    gamesGrid.appendChild(gameElement);
                });
            }
        }
    }
});

//  new game created
socket.on('game:created', (data) => {
    console.log('New game created:', data);
    
    // Convert socket data to the format expected by createGameElement
    const gameData = {
        game_id: data.id || data.game_id,
        id: data.id || data.game_id,
        players: data.players || [],
        state: data.state || 'waiting',
        current_num_players: data.players ? data.players.length : 0
    };
    
    // If we're on page 1, add the new game to the top
    if (addNewGameToTop(gameData)) {
        showNotification(`New game #${gameData.game_id} created!`, 'success');
    } else {
        // If not on page 1, just show notification
        showNewGameNotification();
    }
});

//  game joined
socket.on('game:joined', (data) => {
    console.log('Game joined:', data);
    
    // Try to update the specific game if it's visible
    // Convert socket data format
    const gameData = {
        game_id: data.gameId,
        players: data.players || [], // Handle both formats
        state: data.state,
        current_num_players: data.players ? data.players.length : 0
    };
    
    if (updateSingleGameElement(data.gameId, gameData)) {
        showNotification(`Player joined game #${data.gameId}`, 'info');
        // Update our local data too
        updateLocalGameData(data.gameId, gameData);
    } else if (gameState.currentPage === 1) {
        // Only fetch if game should be visible but isn't (edge case)
        console.log('Game not visible but should be, refreshing page 1');
        fetchGames(1);
    } else {
        showGameUpdateNotification(`Game #${data.gameId} updated`);
    }
});

//  game ended
socket.on('game:ended', (data) => {
    console.log('Game ended:', data);
    
    // Remove the game from view if it's visible
    if (removeGameFromView(data.gameId)) {
        showNotification(`Game #${data.gameId} ended`, 'info');
        
        // If we're running low on games on this page, try to fetch more
        const gamesGrid = document.getElementById('active-games');
        if (gamesGrid && gamesGrid.children.length < 5 && gameState.currentPage < gameState.totalPages) {
            console.log('Running low on games, fetching current page to backfill');
            fetchGames(gameState.currentPage);
        }
    }
});

// new game state change api call
socket.on('game:stateChanged', (data) => {
    console.log('Game state changed:', data);
    
    const gameData = {
        game_id: data.gameId,
        state: data.state,
        players: data.players || [],
        current_num_players: data.players ? data.players.length : 0
    };
    
    if (updateSingleGameElement(data.gameId, gameData)) {
        updateLocalGameData(data.gameId, gameData);
        showNotification(`Game #${data.gameId} ${data.state}`, 'info');
    } else if (gameState.currentPage === 1) {
        // Only refresh if we're on page 1 and the game should be visible
        fetchLatestGames();
    }
});

// Enhanced error handling for socket events
socket.on('lobby:messageError', (data) => {
    console.error('Message error:', data);
    showNotification(data.error || 'Message failed to send', 'warning');
});
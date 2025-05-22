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
const gameStatus = document.getElementById('game-status');
const startGameBtn = document.getElementById('start-game-btn');
const playerHand = document.getElementById('player-hand');
const pileCount = document.getElementById('pile-count');
const declaredRank = document.getElementById('declared-rank');
const playForm = document.getElementById('play-form');
const callBSBtn = document.getElementById('call-bs-btn');

// Game state
let isGameStarted = false;
let playerPosition = -1;
let totalPlayers = 0;
let currentHand = [];

// Game mechanics
let isMyTurn = false;

// Initialize UI
if (gameStatus) gameStatus.textContent = 'Waiting for players...';

// Handle starting the game
startGameBtn?.addEventListener('click', async () => {
    if (isGameStarted) return;
    
    try {
        const response = await fetch(`/games/${gameId}/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            if (gameStatus) gameStatus.textContent = 'Starting game...';
            if (startGameBtn) startGameBtn.disabled = true;
            socket.emit('game:start', { gameId }, (response) => {
                if (response?.error) {
                    console.error('Error starting game:', response.error);
                    if (gameStatus) gameStatus.textContent = response.error;
                    if (startGameBtn) startGameBtn.disabled = false;
                }
            });
        } else {
            const error = await response.json();
            if (gameStatus) gameStatus.textContent = error.error || 'Failed to start game';
        }
    } catch (error) {
        console.error('Error starting game:', error);
        if (gameStatus) gameStatus.textContent = 'Failed to start game';
    }
});

// Handle game events
socket.on('game:started', (data) => {
    isGameStarted = true;
    playerPosition = data.playerPosition;
    totalPlayers = data.totalPlayers;
    currentHand = data.hand;

    if (startGameBtn) startGameBtn.style.display = 'none';
    if (gameStatus) gameStatus.textContent = 'Game in progress';
    
    renderPlayerHand(data.hand);
});

// Render the player's hand
function renderPlayerHand(cards) {
    if (!playerHand) return;
    
    playerHand.innerHTML = '';
    cards.forEach(card => {
        const cardElement = document.createElement('div');
        cardElement.className = 'card';
        cardElement.textContent = getCardDisplay(card);
        cardElement.dataset.cardId = card.card_id;
        playerHand.appendChild(cardElement);
    });
}

// Helper function to format card display
function getCardDisplay(card) {
    const valueMap = {
        1: 'A', 11: 'J', 12: 'Q', 13: 'K'
    };
    const value = valueMap[card.value] || card.value;
    const shape = card.shape.charAt(0).toUpperCase();
    return `${value}${shape}`;
}

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

// Update turn state
function updateTurnState(currentTurn) {
    isMyTurn = playerPosition === currentTurn;
    if (gameStatus) {
        if (isMyTurn) {
            gameStatus.textContent = "It's your turn!";
            if (playForm) playForm.style.display = 'block';
        } else {
            gameStatus.textContent = `Waiting for player ${currentTurn + 1}...`;
            if (playForm) playForm.style.display = 'none';
        }
    }
}

// Handle play form submission
playForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isMyTurn) return;

    const selectedCards = Array.from(document.querySelectorAll('.card.selected')).map(card => {
        const cardId = card.dataset.cardId;
        return currentHand.find(h => h.card_id.toString() === cardId);
    });

    if (selectedCards.length === 0) {
        if (gameStatus) gameStatus.textContent = 'Please select cards to play';
        return;
    }

    const declaredRankSelect = document.getElementById('declared-rank-select');
    const declaredRank = declaredRankSelect?.value;

    socket.emit('game:playCards', {
        gameId,
        cards: selectedCards,
        declaredRank
    }, (response) => {
        if (response?.error) {
            if (gameStatus) gameStatus.textContent = response.error;
            return;
        }
        // Remove played cards from hand
        currentHand = currentHand.filter(card => 
            !selectedCards.some(played => played.card_id === card.card_id)
        );
        renderPlayerHand(currentHand);
    });
});

// Handle BS button
callBSBtn?.addEventListener('click', () => {
    socket.emit('game:callBS', { gameId }, (response) => {
        if (response?.error) {
            if (gameStatus) gameStatus.textContent = response.error;
            return;
        }
    });
});

// Handle card selection
document.getElementById('player-hand')?.addEventListener('click', (e) => {
    if (!isMyTurn) return;
    const card = e.target.closest('.card');
    if (card) {
        card.classList.toggle('selected');
    }
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

// Socket event handlers for game mechanics
socket.on('game:turnUpdate', ({ currentTurn }) => {
    updateTurnState(currentTurn);
});

socket.on('game:cardPlayed', ({ playerPosition: playedByPosition, cardCount, declaredRank, nextTurn }) => {
    // Update the UI to show what was played
    if (gameStatus) {
        gameStatus.textContent = `Player ${playedByPosition + 1} played ${cardCount} ${declaredRank}s`;
    }
    if (declaredRank) {
        const declaredRankSpan = document.getElementById('declared-rank');
        if (declaredRankSpan) declaredRankSpan.textContent = declaredRank;
    }
    updateTurnState(nextTurn);
});

socket.on('game:bsResult', ({ callingPlayer, calledPlayer, wasBluffing, cards }) => {
    const callingPlayerPosition = playerPosition === callingPlayer ? 'You' : `Player ${callingPlayer + 1}`;
    const calledPlayerPosition = playerPosition === calledPlayer ? 'you' : `Player ${calledPlayer + 1}`;
    
    if (gameStatus) {
        if (wasBluffing) {
            gameStatus.textContent = `${callingPlayerPosition} caught ${calledPlayerPosition} bluffing!`;
        } else {
            gameStatus.textContent = `${callingPlayerPosition} called BS wrong! ${calledPlayerPosition} were honest.`;
        }
    }

    // If we were involved in the BS call, update our hand
    if (playerPosition === calledPlayer || playerPosition === callingPlayer) {
        // Server will send updated hands in a separate event
        socket.emit('game:getUpdatedHand', { gameId });
    }
});

// Handle game state
socket.on('game:state', (data) => {
    // Update game state
    isGameStarted = data.gameState.state === 'playing';
    playerPosition = data.yourPosition;
    totalPlayers = data.players.length;
    currentHand = data.hand;

    // Update UI
    if (startGameBtn) {
        if (isGameStarted) {
            startGameBtn.style.display = 'none';
        } else {
            startGameBtn.style.display = 'block';
            startGameBtn.disabled = false;
        }
    }

    if (gameStatus) {
        if (!isGameStarted) {
            gameStatus.textContent = 'Waiting for game to start...';
        } else {
            updateTurnState(data.currentTurn);
        }
    }

    // Update player hand
    renderPlayerHand(data.hand);

    // Update declared rank if there was a last play
    if (data.lastPlay && declaredRank) {
        declaredRank.textContent = data.lastPlay.declaredRank;
    }

    // Update player info in UI
    updatePlayerList(data.players);
});

// Function to update player list display
function updatePlayerList(players) {
    const gameInfo = document.querySelector('.game-info');
    if (!gameInfo) return;

    // Remove existing player list if any
    const existingList = gameInfo.querySelector('.player-list');
    if (existingList) existingList.remove();

    // Create new player list
    const playerList = document.createElement('div');
    playerList.className = 'player-list';
    
    players.forEach(player => {
        const playerEl = document.createElement('div');
        playerEl.className = 'player-info';
        if (player.position === playerPosition) playerEl.classList.add('current-player');
        
        playerEl.innerHTML = `
            <span class="player-name">${player.username}</span>
            <span class="card-count">${player.card_count} cards</span>
        `;
        playerList.appendChild(playerEl);
    });

    gameInfo.appendChild(playerList);
}

// Request game state on page load
window.addEventListener('load', () => {
    socket.emit('game:getState', { gameId }, (response) => {
        if (response?.error) {
            console.error('Error getting game state:', response.error);
            if (gameStatus) gameStatus.textContent = 'Error loading game state';
            return;
        }
        if (response?.success && response.state) {
            socket.emit('game:state', response.state);
        }
    });
});

// Handle disconnection cleanup
window.addEventListener('beforeunload', () => {
    socket.emit('game:leave-room', { gameId });
});

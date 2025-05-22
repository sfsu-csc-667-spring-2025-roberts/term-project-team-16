// Establish socket connection
const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity, // Keep trying to reconnect
    transports: ['websocket', 'polling'],
    path: '/socket.io',
    autoConnect: true,
    timeout: 10000
});

// Extract gameId from the URL path
const pathParts = window.location.pathname.split('/');
const gameId = pathParts[pathParts.length - 1]; // This should be a string

// DOM Element References (ensure these IDs exist in your game.ejs)
const chatForm = document.getElementById('game-chat-form');
const chatInput = document.getElementById('game-chat-input');
const chatMessagesList = document.getElementById('game-chat-messages');
// const submitChatButton = chatForm?.querySelector('button[type="submit"]'); // Not strictly needed if chatForm listener handles disable

const gameStatusEl = document.getElementById('game-status');
const startGameBtn = document.getElementById('start-game-btn');
const playerHandEl = document.getElementById('player-hand');
const pileInfoEl = document.getElementById('pile-info');
const currentDeclarationEl = document.getElementById('current-declaration');
const playForm = document.getElementById('play-form');
const playCardsBtn = document.getElementById('play-cards-btn');
const callBSBtn = document.getElementById('call-bs-btn');
const declaredRankSelect = document.getElementById('declared-rank-select');
const gameLogEl = document.getElementById('game-log');
const playerListEl = document.getElementById('player-list-display');

// Client-side state variables
let currentHand = []; 
let myPlayerPosition = -1;
let isMyTurn = false;
let currentGamePhase = 'loading'; // loading, waiting, playing, ended, error

// Utility to escape HTML
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Appends a chat message
function appendChatMessage(data) {
    if (!chatMessagesList) {
        console.warn('[CLIENT_CHAT] chatMessagesList element not found.');
        return;
    }
    const el = document.createElement('li');
    el.className = 'chat-message';
    const username = data.username ? escapeHtml(data.username) : 'System';
    const content = escapeHtml(data.content);
    const time = data.created_at ? new Date(data.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
    el.innerHTML = `<strong>${username}</strong>: ${content} <small>${time}</small>`;
    chatMessagesList.appendChild(el);
    chatMessagesList.scrollTop = chatMessagesList.scrollHeight;
}

// Logs a game action
function logGameAction(message, type = 'info') {
    if (!gameLogEl) {
        console.warn('[CLIENT_LOG] gameLogEl element not found.');
        return;
    }
    const logEntry = document.createElement('p');
    logEntry.className = `log-entry log-${type}`;
    logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    if (gameLogEl.firstChild) {
        gameLogEl.insertBefore(logEntry, gameLogEl.firstChild);
    } else {
        gameLogEl.appendChild(logEntry);
    }
     // Optional: Limit log length
    while (gameLogEl.children.length > 20) { // Keep last 20 entries
        gameLogEl.removeChild(gameLogEl.lastChild);
    }
}

// Renders player's hand
function renderPlayerHand(handCards) {
    if (!playerHandEl) {
        console.warn('[CLIENT_HAND] playerHandEl element not found.');
        return;
    }
    playerHandEl.innerHTML = ''; 
    currentHand = Array.isArray(handCards) ? handCards : []; // Ensure handCards is an array

    currentHand.sort((a, b) => { // Sort cards
        if (a.value === b.value) return a.shape.localeCompare(b.shape);
        return a.value - b.value;
    });

    if (currentHand.length === 0 && currentGamePhase === 'playing') {
        playerHandEl.innerHTML = '<p class="text-center text-gray-400">Your hand is empty!</p>';
    } else if (currentHand.length === 0 && (currentGamePhase === 'waiting' || currentGamePhase === 'loading')) {
         playerHandEl.innerHTML = '<p class="text-center text-gray-400">Waiting for game to start...</p>';
    }


    currentHand.forEach(card => {
        if (typeof card.card_id === 'undefined' || typeof card.value === 'undefined' || typeof card.shape === 'undefined') {
            console.warn('[CLIENT_HAND] Invalid card object received:', card);
            return; // Skip rendering this invalid card
        }
        const cardElement = document.createElement('div');
        cardElement.className = 'card hand-card';
        cardElement.dataset.cardId = card.card_id;
        cardElement.dataset.value = card.value;
        cardElement.dataset.shape = card.shape;

        const valueMap = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
        const displayValue = valueMap[card.value] || card.value.toString();
        const shapeSymbols = { 'hearts': '♥', 'diamonds': '♦', 'clubs': '♣', 'spades': '♠' };
        const displayShape = shapeSymbols[card.shape.toLowerCase()] || card.shape.charAt(0).toUpperCase();
        
        cardElement.textContent = `${displayValue}${displayShape}`;
        if (['hearts', 'diamonds'].includes(card.shape.toLowerCase())) {
            cardElement.classList.add('red-card');
        }

        cardElement.addEventListener('click', () => {
            if (isMyTurn && currentGamePhase === 'playing') {
                cardElement.classList.toggle('selected');
            } else if (currentGamePhase !== 'playing') {
                logGameAction("Game is not currently in play.", "info");
            } else {
                logGameAction("It's not your turn to select cards.", "info");
            }
        });
        playerHandEl.appendChild(cardElement);
    });
}

// Updates player list display
function updatePlayerListDisplay(players, myPos, currentTurnPos) {
    if (!playerListEl) {
        console.warn('[CLIENT_PLAYERS] playerListEl element not found.');
        return;
    }
    playerListEl.innerHTML = '';
    const safePlayers = Array.isArray(players) ? players : [];

    safePlayers.sort((a,b) => a.position - b.position).forEach(player => {
        if (typeof player.position === 'undefined' || !player.username) {
            console.warn('[CLIENT_PLAYERS] Invalid player object in list:', player);
            return; // Skip invalid player object
        }
        const playerDiv = document.createElement('div');
        playerDiv.className = 'player-info-item'; // Make sure this class is defined in your CSS
        if (player.position === myPos) {
            playerDiv.classList.add('current-user-player');
        }
        if (player.position === currentTurnPos && currentGamePhase === 'playing') {
            playerDiv.classList.add('active-turn-player');
        }
        playerDiv.innerHTML = `
            <span class="player-name">${escapeHtml(player.username)} (P${player.position + 1})</span>
            <span class="card-count">${player.card_count} card${player.card_count === 1 ? '' : 's'}</span>
            ${(player.position === currentTurnPos && currentGamePhase === 'playing') ? '<span class="turn-indicator">YOUR TURN</span>' : ''}
        `;
        playerListEl.appendChild(playerDiv);
    });
}

// Socket Connection Event Handlers
socket.on('connect', () => {
    console.log('[CLIENT] Connected to game server. Socket ID:', socket.id);
    appendChatMessage({ content: 'Connected to game server.', username: "System" });
    if (gameId) {
        socket.emit('game:join-room', { gameId }, (response) => {
            if (response?.error) {
                console.error('[CLIENT] Error joining game room:', response.error);
                appendChatMessage({ content: `Error joining game: ${response.error}`, username: 'System' });
                if (gameStatusEl) gameStatusEl.textContent = `Error: ${response.error}`;
                currentGamePhase = 'error';
            } else {
                console.log('[CLIENT] Successfully joined game room:', gameId);
                socket.emit('game:loadMessages', { gameId }); 
            }
        });
    } else {
        console.error('[CLIENT] gameId is not defined. Cannot join room.');
        if (gameStatusEl) gameStatusEl.textContent = "Error: Game ID missing.";
        currentGamePhase = 'error';
    }
});

socket.on('disconnect', (reason) => {
    console.log('[CLIENT] Disconnected from game server:', reason);
    appendChatMessage({ content: `Disconnected: ${reason}. Attempting to reconnect...`, username: 'System' });
    if (gameStatusEl) gameStatusEl.textContent = "Connection lost. Reconnecting...";
    currentGamePhase = 'loading';
    if(playerHandEl) playerHandEl.innerHTML = '<p class="text-center text-gray-400">Reconnecting...</p>';
    if(playerListEl) playerListEl.innerHTML = '';
    if(playForm) playForm.style.display = 'none';
    if(callBSBtn) callBSBtn.style.display = 'none';
    if(startGameBtn) startGameBtn.style.display = 'none';
});

socket.on('connect_error', (error) => {
    console.error('[CLIENT] Connection Error:', error);
    appendChatMessage({ content: `Connection Error: ${error.message}`, username: 'System' });
    if (gameStatusEl) gameStatusEl.textContent = "Could not connect to server.";
    currentGamePhase = 'error';
});

// Core Game State Update Handler
socket.on('game:stateUpdate', (state) => {
    try {
        console.log('%c[CLIENT] Received game:stateUpdate:', 'color: blue; font-weight: bold;', JSON.parse(JSON.stringify(state || {})));

        if (!state || !state.gameState || !state.players || typeof state.gameId === 'undefined') {
            console.error('[CLIENT] Invalid or incomplete state received in game:stateUpdate. Aborting update.', state);
            if (gameStatusEl) gameStatusEl.textContent = "Error: Received corrupt game data.";
            currentGamePhase = 'error';
            return;
        }
        if (state.gameId !== gameId) {
            console.warn(`[CLIENT] Received state for wrong gameId (expected ${gameId}, got ${state.gameId}). Ignoring.`);
            return;
        }

        myPlayerPosition = typeof state.yourPosition === 'number' ? state.yourPosition : -1;
        currentGamePhase = state.gameState.state || 'error';
        isMyTurn = state.currentTurnPosition === myPlayerPosition && currentGamePhase === 'playing';

        if (state.hand && myPlayerPosition !== -1) {
            renderPlayerHand(state.hand);
        } else if (myPlayerPosition === -1 && state.hand && Array.isArray(state.hand) && state.hand.length > 0){
             console.warn("[CLIENT] Received hand data but player position (yourPosition) is unknown or invalid. Hand not rendered.");
        } else if (!state.hand && myPlayerPosition !== -1 && currentGamePhase === 'playing') {
            console.warn("[CLIENT] Expected hand data for player but not received. Rendering empty hand.");
            renderPlayerHand([]); // Render empty if expected but not received
        }


        if (gameStatusEl) {
            if (currentGamePhase === 'waiting') {
                gameStatusEl.textContent = `Waiting for players... (${state.gameState.current_num_players || 0} joined). Min 2 to start.`;
                if(startGameBtn) startGameBtn.style.display = (state.gameState.current_num_players >= 2 && myPlayerPosition !== -1) ? 'block' : 'none';
                if(playForm) playForm.style.display = 'none';
                if(callBSBtn) callBSBtn.style.display = 'none';
            } else if (currentGamePhase === 'playing') {
                if(startGameBtn) startGameBtn.style.display = 'none';
                if(playForm) playForm.style.display = isMyTurn ? 'flex' : 'none';
                
                const canCallBS = state.lastPlay && isMyTurn && myPlayerPosition !== state.lastPlay.playerPosition;
                if(callBSBtn) callBSBtn.style.display = canCallBS ? 'block' : 'none';

                const currentPlayer = state.players.find(p => p.position === state.currentTurnPosition);
                if (currentPlayer) {
                    gameStatusEl.textContent = isMyTurn ? "Your Turn!" : `Waiting for ${escapeHtml(currentPlayer.username)} (P${currentPlayer.position + 1})`;
                } else {
                    gameStatusEl.textContent = "Game in progress... (Turn unclear)";
                }
            } else if (currentGamePhase === 'ended') {
                const winner = state.players.find(p => p.card_count === 0 || p.is_winner); // Check is_winner flag too
                gameStatusEl.textContent = winner ? `Game Over! ${escapeHtml(winner.username)} (P${winner.position + 1}) wins!` : "Game Over!";
                if(playForm) playForm.style.display = 'none';
                if(callBSBtn) callBSBtn.style.display = 'none';
                if(startGameBtn) startGameBtn.style.display = 'none';
            } else if (currentGamePhase === 'error') {
                 gameStatusEl.textContent = "Game Error. Please refresh or check logs.";
            }
        } else { console.warn("[CLIENT] gameStatusEl not found."); }

        if (pileInfoEl) {
            pileInfoEl.textContent = `Pile: ${state.pileCardCount || 0} card${(state.pileCardCount || 0) === 1 ? '' : 's'}`;
        } else { console.warn("[CLIENT] pileInfoEl not found."); }

        if (currentDeclarationEl) {
            if (state.lastPlay && state.players && Array.isArray(state.players)) {
                const playerWhoPlayed = state.players.find(p => p.position === state.lastPlay.playerPosition);
                const declaredBy = playerWhoPlayed ? escapeHtml(playerWhoPlayed.username) : `P${state.lastPlay.playerPosition + 1}`;
                currentDeclarationEl.textContent = `Last: ${declaredBy} declared ${state.lastPlay.cardCount} x ${escapeHtml(state.lastPlay.declaredRank)}`;
            } else {
                currentDeclarationEl.textContent = (currentGamePhase === 'playing') ? 'Pile is clean. Make the first play!' : 'No play yet.';
            }
        } else { console.warn("[CLIENT] currentDeclarationEl not found."); }

        updatePlayerListDisplay(state.players, myPlayerPosition, state.currentTurnPosition);

    } catch (error) {
        console.error('[CLIENT] Error processing game:stateUpdate:', error, 'Received state was:', state);
        if (gameStatusEl) gameStatusEl.textContent = "Client error processing game update. Check console.";
        currentGamePhase = 'error';
    }
});

socket.on('game:newMessage', (data) => {
    if (data.game_id === gameId) {
        appendChatMessage(data);
    }
});

socket.on('game:loadMessages', (messages) => {
    if (chatMessagesList) chatMessagesList.innerHTML = '';
    if (Array.isArray(messages)) {
        messages.forEach(msg => appendChatMessage(msg));
    } else {
        console.warn("[CLIENT_CHAT] game:loadMessages received non-array data:", messages);
    }
});

socket.on('game:actionPlayed', ({ playerPosition, username, cardCount, declaredRank }) => {
    const playerName = username ? escapeHtml(username) : `P${playerPosition + 1}`;
    logGameAction(`${playerName} played ${cardCount} card(s) declared as ${escapeHtml(declaredRank)}.`);
});

socket.on('game:bsResult', ({ callerPosition, callerUsername, challengedPlayerPosition, challengedUsername, wasBluff, revealedCards, pileReceiverPosition, message }) => {
    logGameAction(message, wasBluff ? 'warning' : 'success');
    if (revealedCards && revealedCards.length > 0) {
        const cardsString = revealedCards.map(c => {
            const valueMap = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
            return (valueMap[c.value] || c.value.toString()) + (c.shape ? c.shape.charAt(0).toUpperCase() : '');
        }).join(', ');
        logGameAction(`Revealed cards from play: ${cardsString}`);
    }
    if (currentDeclarationEl) currentDeclarationEl.textContent = 'BS called. Pile resolved.';
});

socket.on('game:gameOver', ({ winnerPosition, winnerUsername, message}) => {
    logGameAction(message, 'success');
    if(gameStatusEl) gameStatusEl.textContent = message;
    currentGamePhase = 'ended';
    if(playForm) playForm.style.display = 'none';
    if(callBSBtn) callBSBtn.style.display = 'none';
    if(startGameBtn) startGameBtn.style.display = 'none';
});


// UI Event Listeners
if (startGameBtn) {
    startGameBtn.addEventListener('click', () => {
        logGameAction('Attempting to start game...', 'info');
        startGameBtn.disabled = true;
        socket.emit('game:start', { gameId }, (response) => {
            startGameBtn.disabled = false;
            if (response?.error) {
                console.error('[CLIENT] Error starting game:', response.error);
                logGameAction(`Error starting game: ${response.error}`, 'error');
                if (gameStatusEl) gameStatusEl.textContent = `Error: ${response.error}`;
            }
            // Success is handled by 'game:stateUpdate'
        });
    });
} else { console.warn("[CLIENT] startGameBtn not found."); }

if (playCardsBtn) {
    playCardsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!isMyTurn) {
            logGameAction("Cannot play: Not your turn.", "error");
            return;
        }
        if (!playerHandEl) {
            logGameAction("Player hand element not found.", "error");
            return;
        }
        const selectedCardsElements = playerHandEl.querySelectorAll('.card.selected');
        if (!selectedCardsElements || selectedCardsElements.length === 0) {
            logGameAction("No cards selected.", "error");
            return;
        }
        const cardsToPlayIds = Array.from(selectedCardsElements).map(el => el.dataset.cardId); // These will be strings
        
        if (!declaredRankSelect) {
            logGameAction("Declared rank select element not found.", "error");
            return;
        }
        const rankToDeclare = declaredRankSelect.value;
        if (!rankToDeclare) {
            logGameAction("Please select a rank to declare.", "error");
            return;
        }

        playCardsBtn.disabled = true;
        socket.emit('game:playCards', { gameId, cardsToPlayIds, declaredRank: rankToDeclare }, (response) => {
            playCardsBtn.disabled = false;
            if (response?.error) {
                console.error('[CLIENT] Error playing cards:', response.error);
                logGameAction(`Error playing cards: ${response.error}`, 'error');
            } else {
                // Clear selection locally for responsiveness, server will send definitive hand state
                selectedCardsElements.forEach(el => el.classList.remove('selected'));
            }
        });
    });
} else { console.warn("[CLIENT] playCardsBtn not found."); }

if (callBSBtn) {
    callBSBtn.addEventListener('click', () => {
        if (currentGamePhase !== 'playing' || !isMyTurn) {
            logGameAction("Cannot call BS now.", "info");
            return;
        }
        logGameAction("Calling BS...", 'info');
        callBSBtn.disabled = true;
        socket.emit('game:callBS', { gameId }, (response) => {
            callBSBtn.disabled = false;
            if (response?.error) {
                console.error('[CLIENT] Error calling BS:', response.error);
                logGameAction(`Error calling BS: ${response.error}`, 'error');
            }
        });
    });
} else { console.warn("[CLIENT] callBSBtn not found."); }

if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!chatInput) {
            console.warn("[CLIENT_CHAT] chatInput element not found for submit.");
            return;
        }
        const message = chatInput.value.trim();
        if (message && socket.connected) {
            socket.emit('game:sendMessage', { gameId, message }, (ack) => {
                if (ack?.error) {
                    appendChatMessage({ content: `Chat send error: ${ack.error}`, username: 'System' });
                }
            });
            chatInput.value = '';
        } else if (!socket.connected) {
            appendChatMessage({ content: 'Cannot send: Not connected.', username: 'System' });
        }
    });
} else { console.warn("[CLIENT_CHAT] chatForm element not found."); }

window.addEventListener('beforeunload', () => {
    if (socket.connected) {
        socket.emit('game:leave-room', { gameId });
    }
});

if (declaredRankSelect) {
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    ranks.forEach(rank => {
        const option = document.createElement('option');
        option.value = rank;
        option.textContent = rank;
        declaredRankSelect.appendChild(option);
    });
} else { console.warn("[CLIENT] declaredRankSelect element not found."); }

// Initial UI state
if(gameStatusEl) gameStatusEl.textContent = "Connecting to game...";
if(playForm) playForm.style.display = 'none';
if(callBSBtn) callBSBtn.style.display = 'none';
if(startGameBtn) startGameBtn.style.display = 'none';
if(playerHandEl) playerHandEl.innerHTML = '<p class="text-center text-gray-400">Loading hand...</p>';
if(playerListEl) playerListEl.innerHTML = '<p class="text-center text-gray-400">Loading players...</p>';

console.log(`[CLIENT] Game ID: ${gameId} - Client script initialized.`);


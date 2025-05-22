// Establish socket connection
const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling'],
    path: '/socket.io',
    autoConnect: true,
    timeout: 10000
});

// Extract gameId from the URL path
const pathParts = window.location.pathname.split('/');
const gameId = pathParts[pathParts.length - 1];

// DOM Element References
const chatForm = document.getElementById('game-chat-form');
const chatInput = document.getElementById('game-chat-input');
const chatMessagesList = document.getElementById('game-chat-messages');
const submitChatButton = chatForm?.querySelector('button[type="submit"]');

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
let currentHand = []; // Stores card objects: { card_id, value, shape }
let myPlayerPosition = -1;
let isMyTurn = false;
let currentGamePhase = 'loading'; // Can be: loading, waiting, playing, ended, error

// Utility to escape HTML for safe rendering in UI
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Appends a chat message to the chat UI
function appendChatMessage(data) {
    if (!chatMessagesList) return;
    const el = document.createElement('li');
    el.className = 'chat-message';
    const username = data.username ? escapeHtml(data.username) : 'System'; // Default to System for system messages
    const content = escapeHtml(data.content);
    const time = data.created_at ? new Date(data.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
    el.innerHTML = `<strong>${username}</strong>: ${content} <small>${time}</small>`;
    chatMessagesList.appendChild(el);
    chatMessagesList.scrollTop = chatMessagesList.scrollHeight; // Auto-scroll to latest message
}

// Logs a game action to the game log UI, prepending new messages
function logGameAction(message, type = 'info') { // type can be 'info', 'error', 'success', 'warning'
    if (!gameLogEl) return;
    const logEntry = document.createElement('p');
    logEntry.className = `log-entry log-${type}`; // For styling based on message type
    logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    if (gameLogEl.firstChild) {
        gameLogEl.insertBefore(logEntry, gameLogEl.firstChild);
    } else {
        gameLogEl.appendChild(logEntry);
    }
}

// Renders the player's hand of cards in the UI
function renderPlayerHand(handCards) {
    if (!playerHandEl) return;
    playerHandEl.innerHTML = ''; // Clear previous hand display
    currentHand = handCards || []; // Update local cache of hand

    // Sort cards for a consistent and organized display (e.g., by value, then shape)
    currentHand.sort((a, b) => {
        if (a.value === b.value) return a.shape.localeCompare(b.shape);
        return a.value - b.value;
    });

    currentHand.forEach(card => {
        const cardElement = document.createElement('div');
        cardElement.className = 'card hand-card'; // Assign classes for styling
        cardElement.dataset.cardId = card.card_id; // Store card ID for later use
        cardElement.dataset.value = card.value;   // Store value
        cardElement.dataset.shape = card.shape;   // Store shape

        // Map card values and shapes to displayable symbols/text
        const valueMap = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
        const displayValue = valueMap[card.value] || card.value.toString();
        const shapeSymbols = { 'hearts': '♥', 'diamonds': '♦', 'clubs': '♣', 'spades': '♠' };
        const displayShape = shapeSymbols[card.shape.toLowerCase()] || card.shape.charAt(0).toUpperCase();
        
        cardElement.textContent = `${displayValue}${displayShape}`; // Set card text (e.g., "A♠", "10♥")
        // Add class for color styling (e.g., red for hearts/diamonds)
        if (card.shape.toLowerCase() === 'hearts' || card.shape.toLowerCase() === 'diamonds') {
            cardElement.classList.add('red-card');
        }

        // Add click listener for selecting/deselecting cards
        cardElement.addEventListener('click', () => {
            if (isMyTurn && currentGamePhase === 'playing') {
                cardElement.classList.toggle('selected'); // Toggle 'selected' class
            } else if (currentGamePhase !== 'playing') {
                logGameAction("Game is not currently in play.", "info");
            } else {
                logGameAction("It's not your turn to select cards.", "info");
            }
        });
        playerHandEl.appendChild(cardElement); // Add card to the hand display
    });
}

// Updates the UI display of players, their card counts, and whose turn it is
function updatePlayerListDisplay(players, myPos, currentTurnPos) {
    if (!playerListEl) return;
    playerListEl.innerHTML = ''; // Clear previous player list

    // Sort players by position for consistent display order
    players.sort((a,b) => a.position - b.position).forEach(player => {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'player-info-item';
        if (player.position === myPos) {
            playerDiv.classList.add('current-user-player'); // Highlight the current user
        }
        if (player.position === currentTurnPos && currentGamePhase === 'playing') {
            playerDiv.classList.add('active-turn-player'); // Highlight player whose turn it is
        }
        playerDiv.innerHTML = `
            <span class="player-name">${escapeHtml(player.username)} (P${player.position + 1})</span>
            <span class="card-count">${player.card_count} card${player.card_count === 1 ? '' : 's'}</span>
            ${(player.position === currentTurnPos && currentGamePhase === 'playing') ? '<span class="turn-indicator">TURN</span>' : ''}
        `;
        playerListEl.appendChild(playerDiv);
    });
}

// Socket Connection Event Handlers
socket.on('connect', () => {
    console.log('Connected to game server. Socket ID:', socket.id);
    appendChatMessage({ content: 'Connected to game server.', username: "System" });
    // Automatically try to join the game room associated with the current gameId
    socket.emit('game:join-room', { gameId }, (response) => {
        if (response?.error) {
            console.error('Error joining game room:', response.error);
            appendChatMessage({ content: `Error joining game: ${response.error}`, username: 'System' });
            if (gameStatusEl) gameStatusEl.textContent = `Error: ${response.error}`;
            currentGamePhase = 'error';
        } else {
            console.log('Successfully joined game room:', gameId);
            // Request chat history for this game upon joining
            socket.emit('game:loadMessages', { gameId }); 
        }
    });
});

socket.on('disconnect', (reason) => {
    console.log('Disconnected from game server:', reason);
    appendChatMessage({ content: `Disconnected: ${reason}. Attempting to reconnect...`, username: 'System' });
    if (gameStatusEl) gameStatusEl.textContent = "Connection lost. Reconnecting...";
    currentGamePhase = 'loading'; // Set phase to loading to reflect reconnection attempt
    // Clear UI elements that depend on an active game state
    if(playerHandEl) playerHandEl.innerHTML = '<p class="text-center text-gray-400">Reconnecting...</p>';
    if(playerListEl) playerListEl.innerHTML = '';
    playForm?.style.display = 'none';
    callBSBtn?.style.display = 'none';
    startGameBtn?.style.display = 'none';
});

socket.on('connect_error', (error) => {
    console.error('Connection Error:', error);
    appendChatMessage({ content: `Connection Error: ${error.message}`, username: 'System' });
    if (gameStatusEl) gameStatusEl.textContent = "Could not connect to server.";
    currentGamePhase = 'error';
});


// Core Game State Update Handler - This is the main function that reacts to server updates
socket.on('game:stateUpdate', (state) => {
    console.log('Received game:stateUpdate:', state);
    if (!state || state.gameId !== gameId) {
        console.warn("Received state for wrong gameId or invalid state. Ignoring.");
        return;
    }

    myPlayerPosition = state.yourPosition ?? -1; // Update current player's position
    currentGamePhase = state.gameState.state; // Update current game phase ('waiting', 'playing', 'ended')
    // Determine if it's the current player's turn
    isMyTurn = state.currentTurnPosition === myPlayerPosition && currentGamePhase === 'playing';

    // Render the player's hand if data is available and position is known
    if (state.hand && myPlayerPosition !== -1) {
        renderPlayerHand(state.hand);
    } else if (myPlayerPosition === -1 && state.hand && state.hand.length > 0){
         // This case indicates an issue, hand data received without knowing who "I" am.
         console.warn("Received hand data but player position (yourPosition) is unknown. Hand not rendered.");
    }

    // Update UI elements based on the game state
    if (gameStatusEl) {
        if (currentGamePhase === 'waiting') {
            gameStatusEl.textContent = `Waiting for players... (${state.gameState.current_num_players} joined). Min 2 to start.`;
            // Show start button if enough players have joined AND the current user is part of the game
            startGameBtn?.style.display = (state.gameState.current_num_players >=2 && myPlayerPosition !== -1) ? 'block' : 'none';
            playForm?.style.display = 'none'; // Hide play form
            callBSBtn?.style.display = 'none';  // Hide BS button
        } else if (currentGamePhase === 'playing') {
            startGameBtn?.style.display = 'none'; // Hide start button
            playForm?.style.display = isMyTurn ? 'flex' : 'none'; // Show play form only if it's my turn
            // Show BS button if: a play has been made, it's my turn, AND I am not the one who made the last play.
            callBSBtn?.style.display = (state.lastPlay && isMyTurn && myPlayerPosition !== state.lastPlay.playerPosition) ? 'block' : 'none';

            const currentPlayer = state.players.find(p => p.position === state.currentTurnPosition);
            if (currentPlayer) {
                gameStatusEl.textContent = isMyTurn ? "Your Turn!" : `Waiting for ${escapeHtml(currentPlayer.username)} (P${currentPlayer.position + 1})`;
            } else {
                // This state should ideally not be reached if currentTurnPosition is always valid in 'playing' phase
                gameStatusEl.textContent = "Game in progress... (Error determining turn)";
            }
        } else if (currentGamePhase === 'ended') {
            const winner = state.players.find(p => p.card_count === 0); // Simple win condition
            gameStatusEl.textContent = winner ? `Game Over! ${escapeHtml(winner.username)} (P${winner.position + 1}) wins!` : "Game Over!";
            playForm?.style.display = 'none';
            callBSBtn?.style.display = 'none';
            startGameBtn?.style.display = 'none'; // Or a "Play Again?" button could be shown
        }
    }

    // Update pile information
    if (pileInfoEl) {
        pileInfoEl.textContent = `Pile: ${state.pileCardCount} card${state.pileCardCount === 1 ? '' : 's'}`;
    }

    // Update display of the last declared play
    if (currentDeclarationEl) {
        if (state.lastPlay) {
            const playerWhoPlayed = state.players.find(p => p.position === state.lastPlay.playerPosition);
            const declaredBy = playerWhoPlayed ? escapeHtml(playerWhoPlayed.username) : `P${state.lastPlay.playerPosition + 1}`;
            currentDeclarationEl.textContent = `Last: ${declaredBy} declared ${state.lastPlay.cardCount} x ${escapeHtml(state.lastPlay.declaredRank)}`;
        } else {
            currentDeclarationEl.textContent = (currentGamePhase === 'playing') ? 'Pile is clean. Make the first play!' : 'No play yet.';
        }
    }
    // Update the list of players and their statuses
    updatePlayerListDisplay(state.players, myPlayerPosition, state.currentTurnPosition);
});

// Handle incoming chat messages
socket.on('game:newMessage', (data) => {
    if (data.game_id === gameId) { // Ensure message is for the current game
        appendChatMessage(data);
    }
});

// Load chat history for the game
socket.on('game:loadMessages', (messages) => {
    if (chatMessagesList) chatMessagesList.innerHTML = ''; // Clear old messages
    messages.forEach(msg => appendChatMessage(msg));
});

// Log when a player makes a play
socket.on('game:actionPlayed', ({ playerPosition, username, cardCount, declaredRank }) => {
    const playerName = username ? escapeHtml(username) : `P${playerPosition + 1}`;
    logGameAction(`${playerName} played ${cardCount} card(s) declared as ${escapeHtml(declaredRank)}.`);
});

// Log the result of a BS call
socket.on('game:bsResult', ({ callerPosition, callerUsername, challengedPlayerPosition, challengedUsername, wasBluff, revealedCards, pileReceiverPosition, message }) => {
    logGameAction(message, wasBluff ? 'warning' : 'success'); // Style log based on outcome
    // Optionally display the cards that were revealed during the BS call
    if (revealedCards && revealedCards.length > 0) {
        const cardsString = revealedCards.map(c => {
            const valueMap = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
            return (valueMap[c.value] || c.value.toString()) + c.shape.charAt(0).toUpperCase();
        }).join(', ');
        logGameAction(`Revealed cards from play: ${cardsString}`);
    }
    if (currentDeclarationEl) currentDeclarationEl.textContent = 'BS called. Pile resolved.';
});

// Handle game over event
socket.on('game:gameOver', ({ winnerPosition, winnerUsername, message}) => {
    logGameAction(message, 'success');
    if(gameStatusEl) gameStatusEl.textContent = message;
    currentGamePhase = 'ended'; // Set game phase
    // Hide action buttons
    playForm?.style.display = 'none';
    callBSBtn?.style.display = 'none';
    startGameBtn?.style.display = 'none'; // Or change to "Play Again?"
});


// UI Event Listeners for Player Actions
startGameBtn?.addEventListener('click', () => {
    logGameAction('Attempting to start game...', 'info');
    startGameBtn.disabled = true; // Prevent double clicks
    socket.emit('game:start', { gameId }, (response) => {
        startGameBtn.disabled = false; // Re-enable button after server response or error
        if (response?.error) {
            console.error('Error starting game:', response.error);
            logGameAction(`Error starting game: ${response.error}`, 'error');
            if (gameStatusEl) gameStatusEl.textContent = `Error: ${response.error}`;
        }
        // Game start success is handled by 'game:stateUpdate'
    });
});

playCardsBtn?.addEventListener('click', (e) => {
    e.preventDefault(); // Prevent form submission if it's part of a form
    if (!isMyTurn) {
        logGameAction("Cannot play: Not your turn.", "error");
        return;
    }
    const selectedCardsElements = playerHandEl?.querySelectorAll('.card.selected');
    if (!selectedCardsElements || selectedCardsElements.length === 0) {
        logGameAction("No cards selected. Click cards in your hand to select them.", "error");
        return;
    }

    const cardsToPlayIds = Array.from(selectedCardsElements).map(el => parseInt(el.dataset.cardId));
    const rankToDeclare = declaredRankSelect?.value;

    if (!rankToDeclare) {
        logGameAction("Please select a rank to declare for your play (e.g., '7', 'Ace').", "error");
        return;
    }

    playCardsBtn.disabled = true; // Disable button to prevent multiple submissions
    socket.emit('game:playCards', { gameId, cardsToPlayIds, declaredRank: rankToDeclare }, (response) => {
        playCardsBtn.disabled = false; // Re-enable button
        if (response?.error) {
            console.error('Error playing cards:', response.error);
            logGameAction(`Error playing cards: ${response.error}`, 'error');
        } else {
            // Visual feedback that cards were sent; actual hand update comes from server
            // logGameAction(`You played ${cardsToPlayIds.length} card(s) as ${escapeHtml(rankToDeclare)}. Waiting for server...`);
            selectedCardsElements.forEach(el => el.classList.remove('selected')); // Clear selection
        }
    });
});

callBSBtn?.addEventListener('click', () => {
    if (currentGamePhase !== 'playing' || !isMyTurn) {
        logGameAction("Cannot call BS now (not your turn or game not in play).", "info");
        return;
    }
    // Client-side check if there's a last play to call BS on (already handled by button visibility)
    // but an extra check here doesn't hurt.
    if (!currentDeclarationEl?.textContent?.includes('Last:')) {
         logGameAction("No recent play to call BS on.", "info");
         return;
    }

    logGameAction("Calling BS...", 'info');
    callBSBtn.disabled = true; // Disable button
    socket.emit('game:callBS', { gameId }, (response) => {
        callBSBtn.disabled = false; // Re-enable
        if (response?.error) {
            console.error('Error calling BS:', response.error);
            logGameAction(`Error calling BS: ${response.error}`, 'error');
        }
        // Outcome and state update are handled by server's 'game:stateUpdate' and 'game:bsResult'
    });
});

// Chat form submission
chatForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const message = chatInput?.value.trim();
    if (message && chatInput) {
        socket.emit('game:sendMessage', { gameId, message }, (ack) => {
            if (ack?.error) {
                // Display send error in chat or log
                appendChatMessage({ content: `Chat send error: ${ack.error}`, username: 'System' });
            }
        });
        chatInput.value = ''; // Clear input field
    }
});

// Notify server when player is leaving the page
window.addEventListener('beforeunload', () => {
    socket.emit('game:leave-room', { gameId });
    // Note: 'beforeunload' doesn't guarantee the message will be sent, especially on mobile.
});

// Populate the declared rank dropdown (Ace to King)
if (declaredRankSelect) {
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    ranks.forEach(rank => {
        const option = document.createElement('option');
        option.value = rank; // Value sent to server
        option.textContent = rank; // Text displayed to user
        declaredRankSelect.appendChild(option);
    });
}

// Initial UI state before connection is fully established or state is received
if(gameStatusEl) gameStatusEl.textContent = "Connecting to game...";
if(playForm) playForm.style.display = 'none';
if(callBSBtn) callBSBtn.style.display = 'none';
if(startGameBtn) startGameBtn.style.display = 'none';


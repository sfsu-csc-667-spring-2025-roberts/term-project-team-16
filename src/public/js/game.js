// /public/js/game.js
class GameClient {
    constructor() {
        this.socket = null;
        this.gameId = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.selectedCards = new Set();
        this.gameState = null;
        
        this.init();
    }

    init() {
        this.gameId = this.extractGameIdFromUrl();
        this.initializeSocket();
        this.setupEventListeners();
        this.setupUIElements();
    }

    extractGameIdFromUrl() {
        const pathParts = window.location.pathname.split('/');
        return pathParts[pathParts.length - 1];
    }

    initializeSocket() {
        console.log('[GameClient] Initializing socket connection...');
        
        // Initialize socket with better configuration
        this.socket = io({
            transports: ['websocket', 'polling'],
            upgrade: true,
            rememberUpgrade: true,
            timeout: 20000,
            forceNew: false,
            reconnection: true,
            reconnectionAttempts: this.maxReconnectAttempts,
            reconnectionDelay: this.reconnectDelay,
            reconnectionDelayMax: 5000,
            maxReconnectionAttempts: this.maxReconnectAttempts,
            randomizationFactor: 0.5
        });

        this.setupSocketEventListeners();
    }

    setupSocketEventListeners() {
        // Connection events
        this.socket.on('connect', () => {
            console.log('[GameClient] Connected to server');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.updateConnectionStatus('Connected', 'success');
            this.joinGameRoom();
        });

        this.socket.on('disconnect', (reason) => {
            console.log('[GameClient] Disconnected from server:', reason);
            this.isConnected = false;
            this.updateConnectionStatus('Disconnected', 'error');
            
            if (reason === 'io server disconnect') {
                // Server disconnected the socket, try to reconnect manually
                this.socket.connect();
            }
        });

        this.socket.on('connect_error', (error) => {
            console.error('[GameClient] Connection error:', error);
            this.isConnected = false;
            this.reconnectAttempts++;
            this.updateConnectionStatus(`Connection error (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'error');
        });

        this.socket.on('reconnect', (attemptNumber) => {
            console.log('[GameClient] Reconnected after', attemptNumber, 'attempts');
            this.updateConnectionStatus('Reconnected', 'success');
            this.joinGameRoom();
        });

        this.socket.on('reconnect_error', (error) => {
            console.error('[GameClient] Reconnection error:', error);
        });

        this.socket.on('reconnect_failed', () => {
            console.error('[GameClient] Failed to reconnect after maximum attempts');
            this.updateConnectionStatus('Connection failed - please refresh the page', 'error');
        });

        // Game-specific events
        this.socket.on('game:stateUpdate', (gameState) => {
            console.log('[GameClient] Game state update received:', gameState);
            this.handleGameStateUpdate(gameState);
        });

        this.socket.on('game:newMessage', (message) => {
            console.log('[GameClient] New message received:', message);
            this.handleNewMessage(message);
        });

        this.socket.on('game:loadMessages', (messages) => {
            console.log('[GameClient] Messages loaded:', messages.length);
            this.handleLoadMessages(messages);
        });

        this.socket.on('game:actionPlayed', (action) => {
            console.log('[GameClient] Action played:', action);
            this.handleActionPlayed(action);
        });

        this.socket.on('game:bsResult', (result) => {
            console.log('[GameClient] BS result:', result);
            this.handleBSResult(result);
        });

        this.socket.on('game:gameOver', (gameOverData) => {
            console.log('[GameClient] Game over:', gameOverData);
            this.handleGameOver(gameOverData);
        });
    }

    updateConnectionStatus(message, type) {
        const statusElement = document.getElementById('connection-status');
        if (!statusElement) {
            // Create status element if it doesn't exist
            const statusDiv = document.createElement('div');
            statusDiv.id = 'connection-status';
            statusDiv.className = 'connection-status';
            document.querySelector('.game-info').prepend(statusDiv);
        }
        
        const status = document.getElementById('connection-status');
        status.textContent = message;
        status.className = `connection-status ${type}`;
        
        // Auto-hide success messages after 3 seconds
        if (type === 'success') {
            setTimeout(() => {
                status.style.display = 'none';
            }, 3000);
        } else {
            status.style.display = 'block';
        }
    }

    joinGameRoom() {
        if (!this.isConnected || !this.gameId) {
            console.error('[GameClient] Cannot join room - not connected or no game ID');
            return;
        }

        console.log('[GameClient] Joining game room:', this.gameId);
        this.socket.emit('game:join-room', { gameId: this.gameId }, (response) => {
            if (response?.error) {
                console.error('[GameClient] Error joining room:', response.error);
                this.updateConnectionStatus(`Error joining game: ${response.error}`, 'error');
            } else {
                console.log('[GameClient] Successfully joined game room');
                this.loadMessages();
            }
        });
    }

    setupEventListeners() {
        // Start game button
        const startBtn = document.getElementById('start-game-btn');
        if (startBtn) {
            startBtn.addEventListener('click', () => this.startGame());
        }

        // Play cards form
        const playForm = document.getElementById('play-form');
        if (playForm) {
            playForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.playSelectedCards();
            });
        }

        // Call BS button
        const callBSBtn = document.getElementById('call-bs-btn');
        if (callBSBtn) {
            callBSBtn.addEventListener('click', () => this.callBS());
        }

        // Chat form
        const chatForm = document.getElementById('game-chat-form');
        if (chatForm) {
            chatForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.sendMessage();
            });
        }
    }

    setupUIElements() {
        // Populate rank selector
        this.populateRankSelector();
    }

    populateRankSelector() {
        const rankSelect = document.getElementById('declared-rank-select');
        if (rankSelect) {
            const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
            rankSelect.innerHTML = '';
            ranks.forEach(rank => {
                const option = document.createElement('option');
                option.value = rank;
                option.textContent = rank;
                rankSelect.appendChild(option);
            });
        }
    }

    // Game actions
    startGame() {
        if (!this.isConnected) {
            this.updateConnectionStatus('Not connected to server', 'error');
            return;
        }

        this.socket.emit('game:start', { gameId: this.gameId }, (response) => {
            if (response?.error) {
                console.error('[GameClient] Error starting game:', response.error);
                alert(`Error starting game: ${response.error}`);
            } else {
                console.log('[GameClient] Game started successfully');
            }
        });
    }

    playSelectedCards() {
        if (!this.isConnected) {
            this.updateConnectionStatus('Not connected to server', 'error');
            return;
        }

        const selectedCardIds = Array.from(this.selectedCards);
        const declaredRank = document.getElementById('declared-rank-select')?.value;

        if (selectedCardIds.length === 0) {
            alert('Please select at least one card to play.');
            return;
        }

        if (!declaredRank) {
            alert('Please select a declared rank.');
            return;
        }

        this.socket.emit('game:playCards', {
            gameId: this.gameId,
            cardsToPlayIds: selectedCardIds,
            declaredRank: declaredRank
        }, (response) => {
            if (response?.error) {
                console.error('[GameClient] Error playing cards:', response.error);
                alert(`Error playing cards: ${response.error}`);
            } else {
                console.log('[GameClient] Cards played successfully');
                this.selectedCards.clear();
            }
        });
    }

    callBS() {
        if (!this.isConnected) {
            this.updateConnectionStatus('Not connected to server', 'error');
            return;
        }

        this.socket.emit('game:callBS', { gameId: this.gameId }, (response) => {
            if (response?.error) {
                console.error('[GameClient] Error calling BS:', response.error);
                alert(`Error calling BS: ${response.error}`);
            } else {
                console.log('[GameClient] BS called successfully');
            }
        });
    }

    sendMessage() {
        if (!this.isConnected) {
            this.updateConnectionStatus('Not connected to server', 'error');
            return;
        }

        const messageInput = document.getElementById('game-chat-input');
        const message = messageInput?.value?.trim();

        if (!message) {
            return;
        }

        this.socket.emit('game:sendMessage', {
            gameId: this.gameId,
            message: message
        }, (response) => {
            if (response?.error) {
                console.error('[GameClient] Error sending message:', response.error);
            } else {
                messageInput.value = '';
            }
        });
    }

    loadMessages() {
        if (!this.isConnected) {
            return;
        }

        this.socket.emit('game:loadMessages', { gameId: this.gameId }, (response) => {
            if (response?.error) {
                console.error('[GameClient] Error loading messages:', response.error);
            }
        });
    }

    // Event handlers
    handleGameStateUpdate(gameState) {
        this.gameState = gameState;
        this.updateGameInfo(gameState);
        this.updatePlayerList(gameState.players);
        this.updatePlayerHand(gameState.hand);
        this.updateGameActions(gameState);
        this.updatePileInfo(gameState);
    }

    updateGameInfo(gameState) {
        const statusElement = document.getElementById('game-status');
        if (statusElement) {
            const state = gameState.gameState.state;
            const playerCount = gameState.gameState.current_num_players;
            statusElement.textContent = `Status: ${state} | Players: ${playerCount}`;
        }
    }

    updatePlayerList(players) {
        const playerListElement = document.getElementById('player-list-display');
        if (!playerListElement) return;

        playerListElement.innerHTML = '';
        players.forEach(player => {
            const playerDiv = document.createElement('div');
            playerDiv.className = 'player-item p-2 bg-gray-700 rounded';
            
            let statusText = '';
            if (player.isWinner) {
                statusText = ' 👑 WINNER';
            } else if (player.isCurrentTurn) {
                statusText = ' 🎯 TURN';
            }

            playerDiv.innerHTML = `
                <div class="player-name font-medium">${player.username} (P${player.position + 1})</div>
                <div class="player-cards text-sm text-gray-300">Cards: ${player.card_count}${statusText}</div>
            `;
            
            if (player.isCurrentTurn) {
                playerDiv.classList.add('border-2', 'border-blue-500');
            }
            
            playerListElement.appendChild(playerDiv);
        });
    }

    updatePlayerHand(hand) {
        const handElement = document.getElementById('player-hand');
        if (!handElement || !hand) return;

        handElement.innerHTML = '';
        hand.forEach(card => {
            const cardElement = document.createElement('div');
            cardElement.className = 'card';
            cardElement.dataset.cardId = card.card_id;
            
            const displayValue = card.value === 1 ? 'A' : 
                               card.value === 11 ? 'J' : 
                               card.value === 12 ? 'Q' : 
                               card.value === 13 ? 'K' : 
                               card.value.toString();
            
            const suitSymbol = {
                'hearts': '♥️',
                'diamonds': '♦️',
                'clubs': '♣️',
                'spades': '♠️'
            }[card.shape] || '?';

            cardElement.innerHTML = `
                <div class="card-content">
                    <span class="card-value">${displayValue}</span>
                    <span class="card-suit">${suitSymbol}</span>
                </div>
            `;

            cardElement.addEventListener('click', () => this.toggleCardSelection(card.card_id, cardElement));
            handElement.appendChild(cardElement);
        });
    }

    toggleCardSelection(cardId, cardElement) {
        if (this.selectedCards.has(cardId)) {
            this.selectedCards.delete(cardId);
            cardElement.classList.remove('selected');
        } else {
            this.selectedCards.add(cardId);
            cardElement.classList.add('selected');
        }
    }

    updateGameActions(gameState) {
        const actionsContainer = document.getElementById('game-actions-container');
        const playForm = document.getElementById('play-form');
        const callBSBtn = document.getElementById('call-bs-btn');
        const startBtn = document.getElementById('start-game-btn');

        if (!actionsContainer) return;

        const isPlaying = gameState.gameState.state === 'playing';
        const isMyTurn = gameState.players.some(p => p.isCurrentTurn && p.position === gameState.yourPosition);
        const hasLastPlay = gameState.lastPlay !== null;

        // Show/hide start button
        if (startBtn) {
            startBtn.style.display = isPlaying ? 'none' : 'block';
        }

        // Show/hide actions container
        actionsContainer.style.display = isPlaying ? 'block' : 'none';

        // Show/hide play form and BS button
        if (playForm && callBSBtn) {
            if (isMyTurn) {
                if (hasLastPlay) {
                    // Can either play cards or call BS
                    playForm.style.display = 'block';
                    callBSBtn.style.display = 'block';
                } else {
                    // First play of the game, can only play cards
                    playForm.style.display = 'block';
                    callBSBtn.style.display = 'none';
                }
            } else {
                // Not my turn
                playForm.style.display = 'none';
                callBSBtn.style.display = 'none';
            }
        }
    }

    updatePileInfo(gameState) {
        const pileInfoElement = document.getElementById('pile-info');
        const declarationElement = document.getElementById('current-declaration');

        if (pileInfoElement) {
            pileInfoElement.textContent = `Pile: ${gameState.pileCardCount} cards`;
        }

        if (declarationElement) {
            if (gameState.lastPlay) {
                const playerName = gameState.players.find(p => p.position === gameState.lastPlay.playerPosition)?.username || 'Unknown';
                declarationElement.textContent = `Last play: ${playerName} played ${gameState.lastPlay.cardCount} ${gameState.lastPlay.declaredRank}(s)`;
            } else {
                declarationElement.textContent = 'No play has been made yet.';
            }
        }
    }

    handleNewMessage(message) {
        const chatMessages = document.getElementById('game-chat-messages');
        if (!chatMessages) return;

        const messageElement = document.createElement('li');
        messageElement.className = 'chat-message';
        
        const timestamp = new Date(message.created_at).toLocaleTimeString();
        messageElement.innerHTML = `
            <div class="message-header text-xs text-gray-400">${message.username} - ${timestamp}</div>
            <div class="message-content">${this.escapeHtml(message.content)}</div>
        `;

        chatMessages.appendChild(messageElement);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    handleLoadMessages(messages) {
        const chatMessages = document.getElementById('game-chat-messages');
        if (!chatMessages) return;

        chatMessages.innerHTML = '';
        messages.forEach(message => this.handleNewMessage(message));
    }

    handleActionPlayed(action) {
        this.addGameLogEntry(`${action.username} played ${action.cardCount} card(s) as ${action.declaredRank}(s)`);
    }

    handleBSResult(result) {
        const resultText = result.wasBluff 
            ? `${result.callerUsername} correctly called BS! ${result.challengedUsername} was bluffing.`
            : `${result.callerUsername} called BS, but ${result.challengedUsername} was NOT bluffing!`;
        
        this.addGameLogEntry(resultText);
    }

    handleGameOver(gameOverData) {
        this.addGameLogEntry(`🎉 GAME OVER! ${gameOverData.message}`);
        
        // Disable game actions
        const actionsContainer = document.getElementById('game-actions-container');
        if (actionsContainer) {
            actionsContainer.style.display = 'none';
        }
    }

    addGameLogEntry(message) {
        const gameLog = document.getElementById('game-log');
        if (!gameLog) return;

        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry text-sm mb-1';
        logEntry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
        
        gameLog.appendChild(logEntry);
        gameLog.scrollTop = gameLog.scrollHeight;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize the game client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    console.log('[GameClient] DOM loaded, initializing game client...');
    window.gameClient = new GameClient();
});
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
        this.pendingWinTimer = null;
        
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

        this.socket.on('game:pendingWin', (pendingWinData) => {
            console.log('[GameClient] Pending win:', pendingWinData);
            this.handlePendingWin(pendingWinData);
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
        
        // Create pending win display if it doesn't exist
        this.createPendingWinDisplay();
    }

    createPendingWinDisplay() {
        if (!document.getElementById('pending-win-display')) {
            const pendingWinDiv = document.createElement('div');
            pendingWinDiv.id = 'pending-win-display';
            pendingWinDiv.className = 'pending-win-display hidden';
            pendingWinDiv.innerHTML = `
                <div class="pending-win-content bg-yellow-600 text-white p-4 rounded-lg mb-4">
                    <div class="pending-win-message font-bold text-lg mb-2"></div>
                    <div class="pending-win-timer text-2xl font-mono"></div>
                </div>
            `;
            
            const gameInfo = document.querySelector('.game-info');
            if (gameInfo) {
                gameInfo.appendChild(pendingWinDiv);
            }
            
            // Add event listener for pending BS button
            const pendingBSBtn = document.getElementById('pending-bs-btn');
            if (pendingBSBtn) {
                pendingBSBtn.addEventListener('click', () => this.callBS());
            }
        }
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
        this.updatePendingWin(gameState.pendingWin);
    }

    updateGameInfo(gameState) {
        const statusElement = document.getElementById('game-status');
        if (statusElement) {
            const state = gameState.gameState.state;
            const playerCount = gameState.gameState.current_num_players;
            let statusText = `Status: ${state} | Players: ${playerCount}`;
            
            if (state === 'pending_win' && gameState.pendingWin) {
                statusText += ` | ${gameState.pendingWin.playerUsername} might win!`;
            }
            
            statusElement.textContent = statusText;
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
        const isPendingWin = gameState.gameState.state === 'pending_win';
        const isMyTurn = gameState.players.some(p => p.isCurrentTurn && p.position === gameState.yourPosition);
        const hasLastPlay = gameState.lastPlay !== null;

        // Show/hide start button
        if (startBtn) {
            startBtn.style.display = (isPlaying || isPendingWin) ? 'none' : 'block';
        }

        // Show/hide actions container
        actionsContainer.style.display = (isPlaying || isPendingWin) ? 'block' : 'none';

        // Show/hide play form and BS button
        if (playForm && callBSBtn) {
            if (isPendingWin) {
                // During pending win, only show BS button (for non-winner players)
                playForm.style.display = 'none';
                const pendingWin = gameState.pendingWin;
                const isWinningPlayer = pendingWin && pendingWin.playerPosition === gameState.yourPosition;
                callBSBtn.style.display = (!isWinningPlayer && hasLastPlay) ? 'block' : 'none';
            } else if (isMyTurn) {
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

    updatePendingWin(pendingWin) {
        const pendingWinDisplay = document.getElementById('pending-win-display');
        
        if (!pendingWinDisplay) {
            this.createPendingWinDisplay();
            return this.updatePendingWin(pendingWin);
        }

        if (pendingWin) {
            // Show pending win display
            pendingWinDisplay.classList.remove('hidden');
            
            const messageElement = pendingWinDisplay.querySelector('.pending-win-message');
            const timerElement = pendingWinDisplay.querySelector('.pending-win-timer');
            const actionsElement = pendingWinDisplay.querySelector('.pending-win-actions');
            
            if (messageElement) {
                messageElement.textContent = `${pendingWin.playerUsername} (P${pendingWin.playerPosition + 1}) played their last card!`;
            }
            
            if (timerElement) {
                timerElement.textContent = `${pendingWin.timeRemaining}s`;
            }
            
            // Hide BS button for the winning player
            if (actionsElement) {
                const isWinningPlayer = this.gameState && pendingWin.playerPosition === this.gameState.yourPosition;
                actionsElement.style.display = isWinningPlayer ? 'none' : 'block';
            }
            
            // Clear existing timer
            if (this.pendingWinTimer) {
                clearInterval(this.pendingWinTimer);
            }
            
            // Start countdown timer
            let timeRemaining = pendingWin.timeRemaining;
            this.pendingWinTimer = setInterval(() => {
                timeRemaining--;
                if (timerElement) {
                    timerElement.textContent = `${Math.max(0, timeRemaining)}s`;
                }
                
                if (timeRemaining <= 0) {
                    clearInterval(this.pendingWinTimer);
                    this.pendingWinTimer = null;
                }
            }, 1000);
            
        } else {
            // Hide pending win display
            pendingWinDisplay.classList.add('hidden');
            
            // Clear timer
            if (this.pendingWinTimer) {
                clearInterval(this.pendingWinTimer);
                this.pendingWinTimer = null;
            }
        }
    }

    handlePendingWin(pendingWinData) {
        this.addGameLogEntry(pendingWinData.message);
        
        // Create a visual alert
        const alertDiv = document.createElement('div');
        alertDiv.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 bg-yellow-600 text-white px-6 py-3 rounded-lg font-bold text-lg z-50 animate-pulse';
        alertDiv.textContent = `⚠️ ${pendingWinData.playerUsername} might win! Call BS if they're bluffing!`;
        document.body.appendChild(alertDiv);
        
        // Remove alert after 5 seconds
        setTimeout(() => {
            if (alertDiv.parentNode) {
                alertDiv.parentNode.removeChild(alertDiv);
            }
        }, 5000);
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
        
        // Show revealed cards for a moment
        if (result.revealedCards && result.revealedCards.length > 0) {
            this.showRevealedCards(result.revealedCards, result.challengedUsername);
        }
    }

    showRevealedCards(cards, playerName) {
        const revealDiv = document.createElement('div');
        revealDiv.className = 'fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-black bg-opacity-80 text-white p-6 rounded-lg z-50';
        
        let cardsHtml = cards.map(card => {
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
            
            return `<span class="inline-block bg-white text-black px-2 py-1 rounded mx-1">${displayValue}${suitSymbol}</span>`;
        }).join('');
        
        revealDiv.innerHTML = `
            <div class="text-center">
                <div class="text-lg font-bold mb-2">${playerName}'s cards revealed:</div>
                <div class="mb-4">${cardsHtml}</div>
                <div class="text-sm text-gray-300">Closing in 3 seconds...</div>
            </div>
        `;
        
        document.body.appendChild(revealDiv);
        
        setTimeout(() => {
            if (revealDiv.parentNode) {
                revealDiv.parentNode.removeChild(revealDiv);
            }
        }, 3000);
    }

    handleGameOver(gameOverData) {
        this.addGameLogEntry(`🎉 GAME OVER! ${gameOverData.message}`);
        
        // Disable game actions
        const actionsContainer = document.getElementById('game-actions-container');
        if (actionsContainer) {
            actionsContainer.style.display = 'none';
        }
        
        // Hide pending win display
        this.updatePendingWin(null);
        
        // Show game over modal
        const gameOverDiv = document.createElement('div');
        gameOverDiv.className = 'fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-green-600 text-white p-8 rounded-lg z-50 text-center';
        gameOverDiv.innerHTML = `
            <div class="text-2xl font-bold mb-4">🎉 Game Over! 🎉</div>
            <div class="text-lg mb-4">${gameOverData.message}</div>
            <button onclick="window.location.href='/'" class="bg-white text-green-600 px-4 py-2 rounded font-bold hover:bg-gray-100">
                Return to Lobby
            </button>
        `;
        
        document.body.appendChild(gameOverDiv);
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
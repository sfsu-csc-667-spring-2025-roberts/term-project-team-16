import type { Socket } from "socket.io";
import pool from "../config/database";

interface ChatMessage {
    content: string;
    username: string;
    created_at: Date;
    game_id: string;
}

interface Card {
    card_id: number;
    value: number;
    shape: string;
}

interface GameState {
    currentTurn: number;
    lastPlay: {
        playerId: number;
        cards: Card[];
        declaredRank: string;
    } | null;
}

// Track active games state
const gameStates = new Map<string, GameState>();

async function getGameState(gameId: string) {
    // Get game status
    const gameResult = await pool.query(
        'SELECT state, current_num_players FROM game WHERE game_id = $1',
        [gameId]
    );
    
    if (gameResult.rows.length === 0) {
        return null;
    }

    // Get all players
    const playersResult = await pool.query(
        `SELECT gp.position, gp.user_id, u.username,
         (SELECT COUNT(*) FROM cards_held ch 
          WHERE ch.game_player_id = gp.game_player_id) as card_count
         FROM game_players gp
         JOIN "user" u ON gp.user_id = u.user_id
         WHERE gp.game_id = $1
         ORDER BY gp.position`,
        [gameId]
    );

    // Get last play if exists
    const lastPlay = gameStates.get(gameId)?.lastPlay || null;

    return {
        gameState: gameResult.rows[0],
        players: playersResult.rows,
        currentTurn: gameStates.get(gameId)?.currentTurn || 0,
        lastPlay
    };
}

export default function handleGameConnection(socket: Socket): void {
    console.log(`[game] socket connected: ${socket.id}`);

    // Join game room when user enters a game
    socket.on('game:join-room', async ({ gameId }, callback) => {
        try {
            const userId = (socket as any).userId;
            const username = (socket as any).username;

            if (!userId || !username) {
                callback?.({ error: 'Not authenticated' });
                return;
            }

            // Join the game-specific room
            socket.join(`game:${gameId}`);
            console.log(`User ${username} joined game room ${gameId}`);

            // Get player's cards if they're in the game
            const cardsResult = await pool.query(
                `SELECT c.* 
                 FROM cards_held ch
                 JOIN game_players gp ON ch.game_player_id = gp.game_player_id
                 JOIN card c ON ch.card_id = c.card_id
                 WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameId, userId]
            );

            // Get current game state
            const gameState = await getGameState(gameId);
            if (!gameState) {
                callback?.({ error: 'Game not found' });
                return;
            }

            // Send game state to the joining player
            socket.emit('game:state', {
                ...gameState,
                hand: cardsResult.rows,
                yourPosition: gameState.players.find(p => p.user_id === userId)?.position
            });

            callback?.({ success: true });
        } catch (error) {
            console.error('Error joining game room:', error);
            callback?.({ error: 'Failed to join game room' });
        }
    });

    // Leave game room
    socket.on('game:leave-room', ({ gameId }, callback) => {
        socket.leave(`game:${gameId}`);
        callback?.({ success: true });
    });

    // Handle game chat messages
    socket.on('game:sendMessage', async ({ gameId, message }, callback) => {
        try {
            const userId = (socket as any).userId;
            const username = (socket as any).username;

            if (!userId || !username) {
                callback?.({ error: 'Not authenticated' });
                return;
            }

            // Validate message
            const trimmedMessage = message.trim();
            if (!trimmedMessage || trimmedMessage.length > 500) {
                callback?.({ error: 'Invalid message length' });
                return;
            }

            // Insert message into database
            const result = await pool.query(
                `INSERT INTO messages (content, author, game_id, created_at)
                 VALUES ($1, $2, $3, NOW())
                 RETURNING created_at`,
                [trimmedMessage, userId, gameId]
            );

            // Prepare message data
            const messageData: ChatMessage = {
                content: trimmedMessage,
                username: username,
                created_at: result.rows[0].created_at,
                game_id: gameId
            };

            // Broadcast to all clients in the game room
            socket.to(`game:${gameId}`).emit('game:newMessage', messageData);
            socket.emit('game:newMessage', messageData);

            callback?.({ success: true });
        } catch (error) {
            console.error('Error handling game message:', error);
            callback?.({ error: 'Failed to send message' });
        }
    });

    // Load game chat history
    socket.on('game:loadMessages', async ({ gameId }, callback) => {
        try {
            const result = await pool.query(
                `SELECT m.content, u.username, m.created_at
                 FROM messages m
                 JOIN "user" u ON m.author = u.user_id
                 WHERE m.game_id = $1
                 ORDER BY m.created_at DESC
                 LIMIT 20`,
                [gameId]
            );
            socket.emit('game:loadMessages', result.rows.reverse());
            callback?.({ success: true });
        } catch (error) {
            console.error('Error loading game message history:', error);
            callback?.({ error: 'Failed to load message history' });
        }
    });

    // Start game event
    socket.on('game:start', async ({ gameId }, callback) => {
        try {
            const userId = (socket as any).userId;
            if (!userId) {
                callback?.({ error: 'Not authenticated' });
                return;
            }

            // Check if game is in 'playing' state already
            const gameRes = await pool.query('SELECT state FROM game WHERE game_id = $1', [gameId]);
            if (!gameRes.rows.length || gameRes.rows[0].state !== 'playing') {
                callback?.({ error: 'Game is not ready to start (must be in playing state)'});
                return;
            }

            // Get all players in the game
            const playersRes = await pool.query(
                `SELECT gp.game_player_id, gp.position, u.user_id, u.username
                 FROM game_players gp
                 JOIN "user" u ON gp.user_id = u.user_id
                 WHERE gp.game_id = $1
                 ORDER BY gp.position`,
                [gameId]
            );
            const players = playersRes.rows;
            if (players.length < 2) {
                callback?.({ error: 'Need at least 2 players to start.' });
                return;
            }

            // Deal cards (simple shuffle and assign)
            // Get all cards
            const cardsRes = await pool.query('SELECT * FROM card');
            let cards = cardsRes.rows;
            // Shuffle
            cards = cards.sort(() => Math.random() - 0.5);
            // Remove old hands
            await pool.query(
                `DELETE FROM cards_held WHERE game_player_id IN (
                    SELECT game_player_id FROM game_players WHERE game_id = $1
                )`,
                [gameId]
            );
            // Assign cards round-robin
            for (let i = 0; i < cards.length; i++) {
                const player = players[i % players.length];
                await pool.query(
                    'INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)',
                    [player.game_player_id, cards[i].card_id]
                );
            }

            // Set up initial turn and state
            gameStates.set(gameId, {
                currentTurn: 0,
                lastPlay: null
            });

            // Send each player their hand and info
            for (const player of players) {
                // Get hand for this player
                const handRes = await pool.query(
                    `SELECT c.* FROM cards_held ch JOIN card c ON ch.card_id = c.card_id WHERE ch.game_player_id = $1`,
                    [player.game_player_id]
                );
                // Emit to this player's socket(s)
                socket.to(`user:${player.user_id}`).emit('game:started', {
                    playerPosition: player.position,
                    totalPlayers: players.length,
                    hand: handRes.rows
                });
                // If this is the current user, emit directly
                if ((socket as any).userId === player.user_id) {
                    socket.emit('game:started', {
                        playerPosition: player.position,
                        totalPlayers: players.length,
                        hand: handRes.rows
                    });
                }
            }

            callback?.({ success: true });
        } catch (error) {
            console.error('Error starting game:', error);
            callback?.({ error: 'Failed to start game' });
        }
    });

    // Play cards event
    socket.on('game:playCards', async ({ gameId, cards, declaredRank }, callback) => {
        try {
            const userId = (socket as any).userId;
            if (!userId) {
                callback?.({ error: 'Not authenticated' });
                return;
            }
            // Get player info
            const playerRes = await pool.query(
                `SELECT gp.game_player_id, gp.position FROM game_players gp WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameId, userId]
            );
            if (!playerRes.rows.length) {
                callback?.({ error: 'Not a player in this game' });
                return;
            }
            const player = playerRes.rows[0];
            // Remove played cards from player's hand
            for (const card of cards) {
                await pool.query(
                    'DELETE FROM cards_held WHERE game_player_id = $1 AND card_id = $2',
                    [player.game_player_id, card.card_id]
                );
            }
            // Update last play in memory
            const state = gameStates.get(gameId) || { currentTurn: 0, lastPlay: null };
            state.lastPlay = {
                playerId: player.position,
                cards,
                declaredRank
            };
            // Advance turn
            const playersRes = await pool.query('SELECT COUNT(*) FROM game_players WHERE game_id = $1', [gameId]);
            const totalPlayers = parseInt(playersRes.rows[0].count, 10);
            state.currentTurn = (state.currentTurn + 1) % totalPlayers;
            gameStates.set(gameId, state);

            // Get updated game state including hands
            const updatedState = await getGameState(gameId);
            if (!updatedState) {
                callback?.({ error: 'Failed to get updated game state' });
                return;
            }

            // Get the player's updated hand
            const handRes = await pool.query(
                `SELECT c.* 
                 FROM cards_held ch
                 JOIN game_players gp ON ch.game_player_id = gp.game_player_id
                 JOIN card c ON ch.card_id = c.card_id
                 WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameId, userId]
            );

            // First emit the play event
            socket.to(`game:${gameId}`).emit('game:cardPlayed', {
                playerPosition: player.position,
                cardCount: cards.length,
                declaredRank,
                nextTurn: state.currentTurn
            });
            socket.emit('game:cardPlayed', {
                playerPosition: player.position,
                cardCount: cards.length,
                declaredRank,
                nextTurn: state.currentTurn
            });

            // Then emit updated state to all players
            socket.to(`game:${gameId}`).emit('game:state', {
                ...updatedState,
                hand: [] // Other players get empty hand
            });
            // Current player gets their updated hand
            socket.emit('game:state', {
                ...updatedState,
                hand: handRes.rows,
                yourPosition: player.position
            });

            callback?.({ success: true });
        } catch (error) {
            console.error('Error playing cards:', error);
            callback?.({ error: 'Failed to play cards' });
        }
    });

    // Get updated hand event
    socket.on('game:getUpdatedHand', async ({ gameId }, callback) => {
        try {
            const userId = (socket as any).userId;
            if (!userId) {
                callback?.({ error: 'Not authenticated' });
                return;
            }
            // Get player's game_player_id
            const playerRes = await pool.query(
                `SELECT gp.game_player_id FROM game_players gp WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameId, userId]
            );
            if (!playerRes.rows.length) {
                callback?.({ error: 'Not a player in this game' });
                return;
            }
            const gamePlayerId = playerRes.rows[0].game_player_id;
            // Get hand
            const handRes = await pool.query(
                `SELECT c.* FROM cards_held ch JOIN card c ON ch.card_id = c.card_id WHERE ch.game_player_id = $1`,
                [gamePlayerId]
            );
            socket.emit('game:state', {
                hand: handRes.rows
            });
            callback?.({ success: true });
        } catch (error) {
            console.error('Error getting updated hand:', error);
            callback?.({ error: 'Failed to get updated hand' });
        }
    });

    // Placeholder for Call BS event (to be implemented with full logic)
    socket.on('game:callBS', async ({ gameId }, callback) => {
        // TODO: Implement BS logic (check last play, reveal cards, assign pile, update hands, etc.)
        // For now, just emit a dummy result and update all hands
        try {
            // Example: just broadcast a fake result
            socket.to(`game:${gameId}`).emit('game:bsResult', {
                callingPlayer: 0,
                calledPlayer: 1,
                wasBluffing: false,
                cards: []
            });
            socket.emit('game:bsResult', {
                callingPlayer: 0,
                calledPlayer: 1,
                wasBluffing: false,
                cards: []
            });
            // After BS, emit updated state to all
            const gameState = await getGameState(gameId);
            if (gameState) {
                socket.to(`game:${gameId}`).emit('game:state', gameState);
                socket.emit('game:state', gameState);
            }
            callback?.({ success: true });
        } catch (error) {
            callback?.({ error: 'Failed to process BS call' });
        }
    });

    // After every play, also emit updated state to all players for UI sync
    // (Wrap the playCards handler's callback)
    const origPlayCards = socket.listeners('game:playCards')[0];
    socket.off('game:playCards', origPlayCards);
    socket.on('game:playCards', async (data, callback) => {
        await origPlayCards(data, callback);
        // After play, emit updated state
        const gameId = data.gameId;
        const gameState = await getGameState(gameId);
        if (gameState) {
            socket.to(`game:${gameId}`).emit('game:state', gameState);
            socket.emit('game:state', gameState);
        }
    });

    // --- Add gameplay logic here later ---
}
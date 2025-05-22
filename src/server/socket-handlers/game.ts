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

    // --- Add gameplay logic here later ---
}
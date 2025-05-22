import type { Socket } from "socket.io";
import pool from "../config/database";

// Interface for chat message
interface ChatMessage {
    content: string;
    username: string;
    created_at: Date;
}

interface GameState {
    id: string;
    players: string[];
    started: boolean;
    createdAt: Date;
}

// Track active users and games
const activeUsers = new Map<string, string>(); // socketId -> username
const activeGames = new Map<string, GameState>(); // gameId -> GameState

export default function handleLobbyConnection(socket: Socket): void {
    console.log(`[lobby] socket connected: ${socket.id}`);

    // Check authentication and emit status
    const userId = (socket as any).userId;
    const username = (socket as any).username;
    
    // Emit initial auth status
    socket.emit('auth:status', { 
        authenticated: !!userId,
        username: username || null,
        userId: userId || null
    });

    // If authenticated, add to active users
    if (username) {
        activeUsers.set(socket.id, username);
        socket.broadcast.emit('lobby:userJoined', { username });
    }

    // Load message history when user connects
    (async () => {
        try {
            const result = await pool.query(
                `SELECT m.content, u.username, m.created_at
                 FROM messages m
                 JOIN "user" u ON m.author = u.user_id
                 WHERE m.game_id IS NULL
                 ORDER BY m.created_at DESC
                 LIMIT 20`
            );
            socket.emit('lobby:loadMessages', result.rows.reverse());
        } catch (error) {
            console.error('Error loading message history:', error);
            socket.emit('lobby:messageError', { error: 'Failed to load message history' });
        }
    })();

    // Handle new messages
    socket.on('lobby:sendMessage', async ({ message }, callback) => {
        try {
            // Validate authentication
            if (!userId || !username) {
                callback?.({ error: 'Not authenticated' });
                return;
            }

            // Validate message
            const trimmedMessage = message.trim();
            if (!trimmedMessage || trimmedMessage.length > 500) { // Reasonable message length limit
                callback?.({ error: 'Invalid message length' });
                return;
            }

            // Insert message into database (null game_id for lobby)
            const result = await pool.query(
                `INSERT INTO messages (content, author, game_id, created_at)
                 VALUES ($1, $2, NULL, NOW())
                 RETURNING created_at`,
                [trimmedMessage, userId]
            );

            // Prepare message data
            const messageData: ChatMessage = {
                content: trimmedMessage,
                username: username,
                created_at: result.rows[0].created_at
            };

            // Broadcast to all clients including sender
            socket.broadcast.emit('lobby:newMessage', messageData);
            socket.emit('lobby:newMessage', messageData);

            // Acknowledge successful send
            callback?.({ success: true });
        } catch (error) {
            console.error('Error handling message:', error);
            callback?.({ error: 'Failed to send message' });
            socket.emit('lobby:messageError', { error: 'Failed to send message' });
        }
    });

    // Game management
    socket.on('game:create', async (data, callback) => {
    try {
        const userId = (socket as any).userId;
        const username = (socket as any).username;

        if (!userId || !username) {
            callback?.({ error: 'Not authenticated' });
            return;
        }

        // Create new game in database (4 players max, 1 current, state 'waiting')
        const result = await pool.query(
            `INSERT INTO game (max_num_players, current_num_players, state)
             VALUES ($1, $2, $3)
             RETURNING game_id`,
            [4, 1, 'waiting']
        );

        const gameId = result.rows[0].game_id;

        // Add creator as first player, position 0
        await pool.query(
            `INSERT INTO game_players (game_id, user_id, position)
             VALUES ($1, $2, $3)`,
            [gameId, userId, 0]
        );

        // Optionally update activeGames
        activeGames.set(gameId, {
            id: gameId,
            players: [username],
            started: false,
            createdAt: new Date()
        });

        socket.broadcast.emit('games:list', Array.from(activeGames.values()));
        callback?.({ gameId });
    } catch (error) {
        console.error('Error creating game:', error);
        callback?.({ error: 'Failed to create game' });
    }
});

socket.on('game:join', async ({ gameId }, callback) => {
    try {
        const userId = (socket as any).userId;
        const username = (socket as any).username;

        if (!userId || !username) {
            callback?.({ error: 'Not authenticated' });
            return;
        }

        const game = activeGames.get(gameId);
        if (!game) {
            callback?.({ error: 'Game not found' });
            return;
        }

        if (game.players.length >= 4 || game.started) {
            callback?.({ error: 'Game is full or already started' });
            return;
        }

        // Add player to game in database
        await pool.query(
            `INSERT INTO game_players (game_id, user_id, position)
             VALUES ($1, $2, $3)`,
            [gameId, userId, game.players.length]
        );

        // Update player count in game table
        await pool.query(
            `UPDATE game SET current_num_players = current_num_players + 1 WHERE game_id = $1`,
            [gameId]
        );

        // Update in-memory game
        game.players.push(username);
        activeGames.set(gameId, game);

        socket.broadcast.emit('games:list', Array.from(activeGames.values()));
        callback?.({ success: true });
    } catch (error) {
        console.error('Error joining game:', error);
        callback?.({ error: 'Failed to join game' });
    }
    });

    socket.on('games:list', (callback) => {
        callback?.(Array.from(activeGames.values()));
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`[lobby] socket disconnected: ${socket.id}`);
        const username = (socket as any).username;
        if (username) {
            activeUsers.delete(socket.id);
            socket.broadcast.emit('lobby:userLeft', { username });
        }
    });

    // Handle errors
    socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
    });
}

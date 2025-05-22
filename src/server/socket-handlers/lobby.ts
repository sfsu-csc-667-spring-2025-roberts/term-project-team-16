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
    state: 'waiting' | 'playing' | 'ended';
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

    // Load active games on connect
    (async () => {
        try {
            const result = await pool.query(
                `SELECT g.game_id, g.state, g.current_num_players,
                        array_agg(u.username) as players
                 FROM game g
                 LEFT JOIN game_players gp ON g.game_id = gp.game_id
                 LEFT JOIN "user" u ON gp.user_id = u.user_id
                 WHERE g.state IN ('waiting', 'playing')
                 GROUP BY g.game_id, g.state, g.current_num_players`
            );

            // Update active games in memory
            result.rows.forEach(game => {
                activeGames.set(game.game_id.toString(), {
                    id: game.game_id,
                    players: game.players.filter(Boolean), // Remove null values
                    state: game.state,
                    createdAt: new Date()
                });
            });

            // Send initial games list to client
            socket.emit('games:list', Array.from(activeGames.values()));
        } catch (error) {
            console.error('Error loading active games:', error);
        }
    })();

    // Handle new messages
    socket.on('lobby:sendMessage', async ({ message }, callback) => {
        try {
            if (!userId || !username) {
                callback?.({ error: 'Not authenticated' });
                return;
            }

            const trimmedMessage = message.trim();
            if (!trimmedMessage || trimmedMessage.length > 500) {
                callback?.({ error: 'Invalid message length' });
                return;
            }

            const result = await pool.query(
                `INSERT INTO messages (content, author, game_id, created_at)
                 VALUES ($1, $2, NULL, NOW())
                 RETURNING created_at`,
                [trimmedMessage, userId]
            );

            const messageData: ChatMessage = {
                content: trimmedMessage,
                username: username,
                created_at: result.rows[0].created_at
            };

            socket.broadcast.emit('lobby:newMessage', messageData);
            socket.emit('lobby:newMessage', messageData);

            callback?.({ success: true });
        } catch (error) {
            console.error('Error handling message:', error);
            callback?.({ error: 'Failed to send message' });
        }
    });

    // Game management
    socket.on('game:create', async (data, callback) => {
        try {
            if (!userId || !username) {
                callback?.({ error: 'Not authenticated' });
                return;
            }

            // Create new game in database
            const result = await pool.query(
                `INSERT INTO game (max_num_players, current_num_players, state)
                 VALUES ($1, $2, $3)
                 RETURNING game_id`,
                [4, 1, 'waiting']
            );

            const gameId = result.rows[0].game_id;

            // Add creator as first player
            await pool.query(
                `INSERT INTO game_players (game_id, user_id, position)
                 VALUES ($1, $2, $3)`,
                [gameId, userId, 0]
            );

            // Update active games
            const newGame: GameState = {
                id: gameId,
                players: [username],
                state: 'waiting',
                createdAt: new Date()
            };
            activeGames.set(gameId, newGame);

            // Emit game created event to all clients
            socket.broadcast.emit('game:created', newGame);
            socket.emit('game:created', newGame);

            callback?.({ gameId });
        } catch (error) {
            console.error('Error creating game:', error);
            callback?.({ error: 'Failed to create game' });
        }
    });

    socket.on('game:join', async ({ gameId }, callback) => {
        try {
            if (!userId || !username) {
                callback?.({ error: 'Not authenticated' });
                return;
            }

            const game = activeGames.get(gameId);
            if (!game) {
                callback?.({ error: 'Game not found' });
                return;
            }

            if (game.players.length >= 4 || game.state !== 'waiting') {
                callback?.({ error: 'Game is full or not in waiting state' });
                return;
            }

            // Add player to game in database
            await pool.query(
                `INSERT INTO game_players (game_id, user_id, position)
                 VALUES ($1, $2, $3)`,
                [gameId, userId, game.players.length]
            );

            // Update player count
            await pool.query(
                `UPDATE game 
                 SET current_num_players = current_num_players + 1 
                 WHERE game_id = $1`,
                [gameId]
            );

            // Update in-memory game state
            game.players.push(username);
            activeGames.set(gameId, game);

            // Emit game joined event to all clients
            const gameData = {
                gameId,
                players: game.players,
                state: game.state
            };
            socket.broadcast.emit('game:joined', gameData);
            socket.emit('game:joined', gameData);

            callback?.({ success: true });
        } catch (error) {
            console.error('Error joining game:', error);
            callback?.({ error: 'Failed to join game' });
        }
    });

    socket.on('game:end', async ({ gameId }, callback) => {
        try {
            if (!userId) {
                callback?.({ error: 'Not authenticated' });
                return;
            }

            // Update game state in database
            await pool.query(
                `UPDATE game SET state = 'ended' WHERE game_id = $1`,
                [gameId]
            );

            // Update in-memory game state
            const game = activeGames.get(gameId);
            if (game) {
                game.state = 'ended';
                activeGames.delete(gameId); // Remove ended game from active games

                // Emit game ended event to all clients
                socket.broadcast.emit('game:ended', { gameId });
                socket.emit('game:ended', { gameId });
            }

            callback?.({ success: true });
        } catch (error) {
            console.error('Error ending game:', error);
            callback?.({ error: 'Failed to end game' });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`[lobby] socket disconnected: ${socket.id}`);
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

import { Server as IOServer, Socket as OriginalSocket } from "socket.io";
import pool from "../config/database";
import { AugmentedSocket } from "../config/socket"; // Import AugmentedSocket

// I dont know if this is standard or not, but claude suggested this and it's basically the only way I understand typescript on my own.
//I've only used it to make open source commits to wowAnalyzer and that's basiclly just warcraftlogs api and some math code.
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

// Added io parameter with IOServer type
export default function handleLobbyConnection(io: IOServer, socket: AugmentedSocket): void {
    console.log(`[lobby] socket connected: ${socket.id}`);

    // both of these are directly taken from our socket object and taught me typescript...
    const userId = socket.userId; // Directly use from AugmentedSocket
    const username = socket.username; // Directly use from AugmentedSocket
    
    // emit auth status, feel use this to do anything that might help someone logging in
    socket.emit('auth:status', {
        authenticated: !!userId,
        username: username || null,
        userId: userId || null
    });

    // user joined lobby
    if (username) {
        activeUsers.set(socket.id, username);
        io.emit('lobby:userJoined', { username }); // Emit to all clients in the lobby namespace
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

    // query for active games, emit to lobby
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

            result.rows.forEach(game => {
                activeGames.set(game.game_id.toString(), {
                    id: game.game_id,
                    players: game.players.filter(Boolean),
                    state: game.state,
                    createdAt: new Date() // Consider fetching actual creation date if important
                });
            });
            socket.emit('games:list', Array.from(activeGames.values()));
        } catch (error) {
            console.error('Error loading active games:', error);
        }
    })();

    // feel free to add more security here since this text entry is probably the most vulnerable thing in the app
    // could use all sorts of input validation, xss is frontend only atm
    // https://github.com/socketio/socket.io/issues/126, this is almost as old as I am, kinda based...
    socket.on('lobby:sendMessage', async ({ message }, callback) => {
        try {
            if (!userId || !username) {
                return callback?.({ error: 'Not authenticated' });
            }

            const trimmedMessage = message.trim();
            if (!trimmedMessage || trimmedMessage.length > 500) {
                return callback?.({ error: 'Invalid message length' });
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

            io.emit('lobby:newMessage', messageData); // Emit to all clients in the lobby

            return callback?.({ success: true });
        } catch (error) {
            console.error('Error handling message:', error);
            return callback?.({ error: 'Failed to send message' });
        }
    });

    // Game management
    socket.on('game:create', async (data, callback) => {
        try {
            //login check
            if (!userId || !username) {
                return callback?.({ error: 'Not authenticated' });
            }
            //associate player to game
            const result = await pool.query(
                `INSERT INTO game (max_num_players, current_num_players, state)
                 VALUES ($1, $2, $3)
                 RETURNING game_id`,
                [4, 1, 'waiting']
            );
            const gameId = result.rows[0].game_id.toString(); // Ensure gameId is string for Map key
            //get player spot within the game, this probably could hard lock the lobby owner or something if we wanted them to...
            await pool.query(
                `INSERT INTO game_players (game_id, user_id, position)
                 VALUES ($1, $2, $3)`,
                [gameId, userId, 0]
            );
            //actual game start code
            const newGame: GameState = {
                id: gameId,
                players: [username],
                state: 'waiting',
                createdAt: new Date()
            };
            activeGames.set(gameId, newGame);
            io.emit('game:created', newGame);
            return callback?.({ gameId });
        } catch (error) {
            console.error('Error creating game:', error);
            return callback?.({ error: 'Failed to create game' });
        }
    });
    // join game
    socket.on('game:join', async ({ gameId }, callback) => {
        try {
            if (!userId || !username) {
                return callback?.({ error: 'Not authenticated' });
            }

            const game = activeGames.get(gameId);
            if (!game) {
                return callback?.({ error: 'Game not found' });
            }
            if (game.players.length >= 4 || game.state !== 'waiting') {
                return callback?.({ error: 'Game is full or not in waiting state' });
            }

            await pool.query(
                `INSERT INTO game_players (game_id, user_id, "position")
                 VALUES ($1, $2, $3)`, // Ensure "position" is quoted if it's a reserved keyword or causing issues
                [gameId, userId, game.players.length]
            );
            await pool.query(
                `UPDATE game SET current_num_players = current_num_players + 1 WHERE game_id = $1`,
                [gameId]
            );

            game.players.push(username);
            activeGames.set(gameId, game);

            const gameData = { gameId, players: game.players, state: game.state };
            io.emit('game:joined', gameData);
            return callback?.({ success: true });
        } catch (error) {
            console.error('Error joining game:', error);
            return callback?.({ error: 'Failed to join game' });
        }
    });
    // remove game from lobby when finished
    socket.on('game:end', async ({ gameId }, callback) => { // this game id is a string
        try {
            if (!userId) {
                return callback?.({ error: 'Not authenticated' });
            }
            await pool.query(
                `UPDATE game SET state = 'ended' WHERE game_id = $1`,
                [parseInt(gameId)] // this game id is a number....
            );
            const game = activeGames.get(gameId);
            if (game) {
                game.state = 'ended';
                activeGames.delete(gameId);
                io.emit('game:ended', { gameId });
            }
            return callback?.({ success: true });
        } catch (error) {
            console.error('Error ending game:', error);
            return callback?.({ error: 'Failed to end game' });
        }
    });

    //user left lobby
    socket.on('disconnect', () => {
        console.log(`[lobby] socket disconnected: ${socket.id}`);
        if (username) {
            activeUsers.delete(socket.id);
            io.emit('lobby:userLeft', { username });
        }
    });

    socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
    });
}
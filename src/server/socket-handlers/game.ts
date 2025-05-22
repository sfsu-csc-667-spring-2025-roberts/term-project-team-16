import type { Socket } from "socket.io";
import pool from "../config/database";

interface ChatMessage {
    content: string;
    username: string;
    created_at: Date;
    game_id: string;
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
}

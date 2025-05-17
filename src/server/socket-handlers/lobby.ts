import type { Socket } from "socket.io";
import pool from "../config/database";

// Interface for chat message
interface ChatMessage {
    content: string;
    username: string;
    created_at: Date;
}

// Track active users in the lobby
const activeUsers = new Map<string, string>(); // socketId -> username

export default function handleLobbyConnection(socket: Socket): void {
    console.log(`[lobby] socket connected: ${socket.id}`);

    // Check authentication and emit status
    const userId = (socket as any).userId;
    const username = (socket as any).username;
    
    // Emit initial auth status
    socket.emit('auth:status', { 
        authenticated: !!userId,
        username: username || null
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

            // Insert message into database
            const result = await pool.query(
                `INSERT INTO messages (content, author, created_at)
                 VALUES ($1, $2, NOW())
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

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`[lobby] socket disconnected: ${socket.id}`);
        if (username && activeUsers.has(socket.id)) {
            activeUsers.delete(socket.id);
            socket.broadcast.emit('lobby:userLeft', { username });
        }
    });

    // Handle errors
    socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
    });
}

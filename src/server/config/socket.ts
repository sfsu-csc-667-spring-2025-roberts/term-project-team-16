import { Server, Socket } from 'socket.io';
import { RequestHandler } from 'express'; // For sessionMiddleware type
import { ExtendedError } from 'socket.io/dist/namespace';

// This function will wrap the express middleware for Socket.IO
const wrap = (middleware: RequestHandler) => (socket: Socket, next: (err?: ExtendedError) => void) =>
    middleware(socket.request as any, {} as any, next as any);

export function configureSockets(io: Server, sessionMiddleware: RequestHandler) { // Pass sessionMiddleware here
    // Use the session middleware for Socket.IO
    io.use(wrap(sessionMiddleware));

    // Authentication check for each socket connection
    io.use((socket: Socket, next: (err?: ExtendedError) => void) => {
        const session = (socket.request as any).session;
        if (session && session.userId) {
            // Attach user info to the socket object for easier access later
            (socket as any).userId = session.userId;
            (socket as any).username = session.username;
            next();
        } else {
            console.log('Socket connection denied: No session or userId');
            next(new Error('Authentication error: Unauthorized'));
        }
    });

    io.on('connection', (socket: Socket) => {
        const userId = (socket as any).userId;
        const username = (socket as any).username;

        console.log(`User connected to Sockets: ${username} (ID: ${userId}, Socket ID: ${socket.id})`);

        // ----- LOBBY CHAT HANDLERS WILL GO HERE -----
        // Example: socket.on('lobby:sendMessage', ...)
        // Example: Load recent lobby messages and send to this socket

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${username} (ID: ${userId}, Socket ID: ${socket.id})`);
        });

        // Error handling for individual sockets
        socket.on('error', (err) => {
            console.error(`Socket error for user ${username} (ID: ${userId}):`, err);
        });
    });

    console.log('Socket.IO configured and listening for connections.');
}
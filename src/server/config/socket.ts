// src/server/config/socket.ts
import { Server, Socket as SocketIOSocket } from 'socket.io';
import { RequestHandler, Response as ExpressResponse, Request as ExpressRequest, NextFunction } from 'express';
import { ExtendedError } from 'socket.io/dist/namespace';
// import pool from './database'; // Not directly used in this file for session attachment
import handleLobbyConnection from '../socket-handlers/lobby';
import handleGameConnection from '../socket-handlers/game';

// Define an interface for the socket object that includes your custom properties
export interface AugmentedSocket extends SocketIOSocket {
    userId?: number;
    username?: string;
}

// Wrapper for express middleware to work with socket.io
const wrap = (middleware: RequestHandler) => (socket: SocketIOSocket, next: (err?: ExtendedError | undefined) => void) => {
    const req = socket.request as ExpressRequest;
    
    // Create a mock response object
    const res = {
        // Minimal mock for session middleware to function without crashing
        setHeader: () => {},
        getHeader: () => undefined,
        end: (cb?: () => void) => { cb?.(); return this; }, // Ensure cb is callable if provided
        writeHead: () => this,
    } as unknown as ExpressResponse;

    middleware(req, res, next as NextFunction);
};

export function configureSockets(io: Server, sessionMiddleware: RequestHandler): void {
    // Socket.IO CORS configuration (already present, seems fine)
    io.engine.on("initial_headers", (headers: Record<string, string>, req) => {
        headers["Access-Control-Allow-Credentials"] = "true";
        headers["Access-Control-Allow-Origin"] = req.headers.origin || "*"; // Consider restricting this in production
    });

    io.engine.opts.pingInterval = 10000;
    io.engine.opts.pingTimeout = 5000;

    // Apply session middleware to Socket.IO
    io.use(wrap(sessionMiddleware));

    // Authentication middleware - CRITICAL POINT
    io.use((socket: SocketIOSocket, next) => {
        const augmentedSocket = socket as AugmentedSocket; // Cast to use custom properties
        const session = (socket.request as any).session;

        if (session && session.userId && session.username) {
            augmentedSocket.userId = session.userId;
            augmentedSocket.username = session.username;
            console.log(`[Socket Auth] User Authenticated: socketId=${socket.id}, userId=${session.userId}, username=${session.username}`);
            next();
        } else {
            // This allows unauthenticated connections.
            // Individual handlers (lobby, game) MUST check for userId/username if an action requires authentication.
            console.log(`[Socket Auth] User NOT fully authenticated (or session incomplete): socketId=${socket.id}. Session userId: ${session?.userId}, Session username: ${session?.username}`);
            // If you want to enforce auth for *all* socket connections, you might do:
            // next(new Error('Authentication required'));
            // However, current design seems to allow connection and then handlers check.
            // We will ensure handlers are robust.
            next();
        }
    });

    // Connection handler
    io.on('connection', (socket: SocketIOSocket) => {
        const augmentedSocket = socket as AugmentedSocket; // Use the augmented type
        console.log(`[Socket Connection] Client connected: socketId=${augmentedSocket.id}, userId=${augmentedSocket.userId || 'N/A'}`);

        // Join user-specific room if authenticated
        if (augmentedSocket.userId) {
            augmentedSocket.join(`user:${augmentedSocket.userId}`);
            console.log(`[Socket Connection] Socket ${augmentedSocket.id} joined user room: user:${augmentedSocket.userId}`);
        }

        augmentedSocket.on('disconnect', (reason) => {
            console.log(`[Socket Disconnect] Client disconnected: socketId=${augmentedSocket.id}, userId=${augmentedSocket.userId || 'N/A'}, reason: ${reason}`);
            if (augmentedSocket.userId) {
                augmentedSocket.leave(`user:${augmentedSocket.userId}`);
            }
        });

        augmentedSocket.on('error', (error) => {
            console.error(`[Socket Error] Error for socket ${augmentedSocket.id}:`, error);
        });

        // Pass the io instance and the correctly typed/augmented socket to handlers
        handleLobbyConnection(io, augmentedSocket);
        handleGameConnection(io, augmentedSocket);
    });

    io.engine.on("connection_error", (err) => {
        console.error('[Socket Engine] Connection error:', err.req, err.code, err.message, err.context);
    });
}

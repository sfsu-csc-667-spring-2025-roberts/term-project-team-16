// src/server/config/socket.ts
import { Server, Socket as SocketIOSocket } from 'socket.io';
import { RequestHandler, Response as ExpressResponse, Request as ExpressRequest, NextFunction } from 'express';
import { ExtendedError } from 'socket.io/dist/namespace';
import pool from './database';
import handleLobbyConnection from '../socket-handlers/lobby';
import handleGameConnection from '../socket-handlers/game';

// Define an interface for the socket object that includes your custom properties
// This can be moved to a central types file if used in multiple places
export interface AugmentedSocket extends SocketIOSocket {
    userId?: number;
    username?: string;
}

// Wrapper for express middleware to work with socket.io
const wrap = (middleware: RequestHandler) => (socket: SocketIOSocket, next: (err?: ExtendedError | undefined) => void) => {
    const req = socket.request as ExpressRequest;
    
    // Create a mock response object that implements the minimum required interface
    const res = {
        end: function(data: any, encoding?: string | Function, callback?: Function) {
            if (typeof encoding === 'function') {
                callback = encoding;
                encoding = undefined;
            }
            callback?.();
            return this;
        },
        setHeader: function(key: string, value: string | number | readonly string[]) {
            return this;
        },
        getHeader: function(key: string) {
            return null;
        },
        writeHead: function(statusCode: number, headers?: any) {
            return this;
        }
    } as unknown as ExpressResponse;

    middleware(req, res, next as NextFunction);
};

export function configureSockets(io: Server, sessionMiddleware: RequestHandler): void {
    // Socket.IO configuration
    io.engine.on("initial_headers", (headers: Record<string, string>, req) => {
        headers["Access-Control-Allow-Credentials"] = "true";
        headers["Access-Control-Allow-Origin"] = req.headers.origin || "*";
    });

    // Configure Socket.IO settings
    io.engine.opts.pingInterval = 10000; // 10 seconds
    io.engine.opts.pingTimeout = 5000;   // 5 seconds

    // Apply session middleware to Socket.IO
    io.use(wrap(sessionMiddleware));

    // Authentication middleware
    io.use((socket: SocketIOSocket, next) => {
        const session = (socket.request as any).session;
        if (session) {
            // Attach user data to socket instance for easy access
            // Use type assertion to AugmentedSocket
            (socket as AugmentedSocket).userId = session.userId;
            (socket as AugmentedSocket).username = session.username;
            next();
        } else {
            // Allow connection without authentication for public chat viewing
            next();
        }
    });

    // Connection handler
    io.on('connection', (socket: SocketIOSocket) => {
        console.log(`Client connected: ${socket.id}`);
        const augmentedSocket = socket as AugmentedSocket; // Use the augmented type

        // Handle user sessions
        const session = (augmentedSocket.request as any).session;
        if (session?.userId) {
            augmentedSocket.join(`user:${session.userId}`);
        }

        // Handle disconnection
        augmentedSocket.on('disconnect', (reason) => {
            console.log(`Client disconnected: ${augmentedSocket.id}, reason: ${reason}`);
            if (session?.userId) {
                augmentedSocket.leave(`user:${session.userId}`);
            }
        });

        // Handle errors
        augmentedSocket.on('error', (error) => {
            console.error(`Socket error for ${augmentedSocket.id}:`, error);
        });

        // Set up lobby and game handlers, passing the correctly typed io and socket
        handleLobbyConnection(io, augmentedSocket);
        handleGameConnection(io, augmentedSocket);
    });

    // Global error handler
    io.engine.on("connection_error", (err) => {
        console.error('Connection error:', err);
    });
}
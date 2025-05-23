// src/server/config/socket.ts
import { Server, Socket as SocketIOSocket } from 'socket.io';
import { RequestHandler, Response as ExpressResponse, Request as ExpressRequest, NextFunction } from 'express';
import { ExtendedError } from 'socket.io/dist/namespace';
import handleLobbyConnection from '../socket-handlers/lobby';
import handleGameConnection from '../socket-handlers/game';

// types for our custom socket class
export interface AugmentedSocket extends SocketIOSocket {
    userId?: number;
    username?: string;
}

//  wrapper for express middleware to work with socket.io by making the formats for both express and socket io fit each other
// idk we just copied the stack, but at least I learned a lot about typescript and fixing sockets
const wrap = (middleware: RequestHandler) => (socket: SocketIOSocket, next: (err?: ExtendedError | undefined) => void) => {
    const req = socket.request as ExpressRequest;
    
    // this might make sockets work sometimes
    const res = {
        setHeader: () => res,
        getHeader: () => undefined,
        removeHeader: () => res,
        writeHead: () => res,
        write: () => res,
        end: (cb?: () => void) => { 
            if (cb) setTimeout(cb, 0); 
            return res; 
        },
        on: () => res,
        once: () => res,
        emit: () => res,
        locals: {},
        headersSent: false,
        statusCode: 200,
        statusMessage: 'OK'
    } as unknown as ExpressResponse;

    try {
        middleware(req, res, next as NextFunction);
    } catch (error) {
        console.error('[Socket Middleware] Error in middleware wrapper:', error);
        next(error as ExtendedError);
    }
};

export function configureSockets(io: Server, sessionMiddleware: RequestHandler): void {
    // CORS config for socket io
    io.engine.on("initial_headers", (headers: Record<string, string>, req) => {
        headers["Access-Control-Allow-Credentials"] = "true";
        const origin = req.headers.origin;
        if (origin) {
            headers["Access-Control-Allow-Origin"] = origin;
        }
    });

    // socket io server timeouts
    io.engine.opts.pingInterval = 25000;  
    io.engine.opts.pingTimeout = 20000;   
    io.engine.opts.upgradeTimeout = 10000;
    io.engine.opts.maxHttpBufferSize = 1e6;

    // Apply session middleware to Socket.IO with error handling
    io.use((socket: SocketIOSocket, next) => {
        wrap(sessionMiddleware)(socket, (err?: ExtendedError) => {
            if (err) {
                console.error('[Socket Session] Session middleware error:', err);
                // Don't block connection, but log the issue
            }
            next();
        });
    });

    // Authentication middleware with better error handling
    io.use((socket: SocketIOSocket, next) => {
        const augmentedSocket = socket as AugmentedSocket;
        
        try {
            const session = (socket.request as any).session;
            
            if (session && session.userId && session.username) {
                augmentedSocket.userId = session.userId;
                augmentedSocket.username = session.username;
                console.log(`[Socket Auth] User authenticated: socketId=${socket.id}, userId=${session.userId}, username=${session.username}`);
            } else {
                console.log(`[Socket Auth] Unauthenticated connection: socketId=${socket.id}`);
                // Set undefined explicitly to ensure consistency
                augmentedSocket.userId = undefined;
                augmentedSocket.username = undefined;
            }
            
            next();
        } catch (error) {
            console.error('[Socket Auth] Authentication error:', error);
            // Allow connection but mark as unauthenticated
            augmentedSocket.userId = undefined;
            augmentedSocket.username = undefined;
            next();
        }
    });

    // Connection handler with better error handling
    io.on('connection', (socket: SocketIOSocket) => {
        const augmentedSocket = socket as AugmentedSocket;
        console.log(`[Socket Connection] Client connected: socketId=${augmentedSocket.id}, userId=${augmentedSocket.userId || 'N/A'}`);

        // Join user-specific room if authenticated
        if (augmentedSocket.userId) {
            try {
                augmentedSocket.join(`user:${augmentedSocket.userId}`);
                console.log(`[Socket Connection] Socket ${augmentedSocket.id} joined user room: user:${augmentedSocket.userId}`);
            } catch (error) {
                console.error(`[Socket Connection] Error joining user room:`, error);
            }
        }

        // Handle disconnection
        augmentedSocket.on('disconnect', (reason) => {
            console.log(`[Socket Disconnect] Client disconnected: socketId=${augmentedSocket.id}, userId=${augmentedSocket.userId || 'N/A'}, reason: ${reason}`);
            
            if (augmentedSocket.userId) {
                try {
                    augmentedSocket.leave(`user:${augmentedSocket.userId}`);
                } catch (error) {
                    console.error(`[Socket Disconnect] Error leaving user room:`, error);
                }
            }
        });

        // Handle socket errors
        augmentedSocket.on('error', (error) => {
            console.error(`[Socket Error] Error for socket ${augmentedSocket.id}:`, error);
        });

        // Handle connection errors
        augmentedSocket.on('connect_error', (error) => {
            console.error(`[Socket Connection Error] Connection error for socket ${augmentedSocket.id}:`, error);
        });

        // Add reconnection handling
        augmentedSocket.on('reconnect', (attemptNumber) => {
            console.log(`[Socket Reconnect] Socket ${augmentedSocket.id} reconnected after ${attemptNumber} attempts`);
        });

        // Pass the io instance and the correctly typed/augmented socket to handlers
        try {
            handleLobbyConnection(io, augmentedSocket);
            handleGameConnection(io, augmentedSocket);
        } catch (error) {
            console.error('[Socket Handlers] Error initializing socket handlers:', error);
        }
    });

    // Handle engine-level connection errors
    io.engine.on("connection_error", (err) => {
        console.error('[Socket Engine] Connection error:', {
            code: err.code,
            message: err.message,
            context: err.context,
            type: err.type
        });
    });

    console.log('[Socket] Socket.IO server configured successfully');
}
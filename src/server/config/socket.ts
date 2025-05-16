// src/server/config/socket.ts
import { Server, Socket as SocketIOSocket } from 'socket.io';
import { RequestHandler, Response as ExpressResponse, Request as ExpressRequest, NextFunction } from 'express';
import { ExtendedError } from 'socket.io/dist/namespace';
import pool from './database'; // Ensure this path is correct

const wrap = (middleware: RequestHandler) => (socket: SocketIOSocket, next: (err?: ExtendedError | undefined) => void) => {
    const req = socket.request as ExpressRequest;
    const originalRes = (socket.request as any).res as ExpressResponse | undefined;
    let resToUse: ExpressResponse;

    // Check if the originalRes looks like a valid, usable http.ServerResponse
    // It must have .setHeader, .getHeader, and critically for express-session, .end and .writeHead (or be able to handle them)
    if (originalRes &&
        typeof originalRes.setHeader === 'function' &&
        typeof originalRes.getHeader === 'function' &&
        typeof originalRes.end === 'function' && // express-session patches this
        typeof originalRes.writeHead === 'function' // Node's res.end might use this
        ) {
        resToUse = originalRes;
    } else {
        // If originalRes is not fully usable for express-session's needs (especially .end),
        // create a mock that handles the essential methods called by express-session and Node's internals.
        // console.warn('Socket.IO: Original socket.request.res is not fully usable. Using a mock for res.');
        resToUse = {
            getHeader: (name: string): string | number | string[] | undefined => {
                // console.log(`Socket MOCK res.getHeader called: ${name}`);
                return undefined;
            },
            setHeader: function(name: string, value: string | number | readonly string[]): ExpressResponse {
                // console.log(`Socket MOCK res.setHeader called for ${name}: ${value}`);
                return this as ExpressResponse; // Return 'this' for chainability
            },
            get headersSent() {
                // express-session checks this to avoid setting headers after they've been sent.
                // For a WebSocket handshake that completes, this might be true.
                // However, for a mock during the middleware phase, false might be safer.
                return false;
            },
            locals: {}, // Provide a locals object, some middleware might use it
            writeHead: function(statusCode: number, statusMessage?: string | any, headers?: any): ExpressResponse {
                // console.log(`Socket MOCK res.writeHead called with statusCode: ${statusCode}`);
                // This is important as Node's res.end() might call writeHead if headers aren't already sent.
                // A real writeHead would set this._header, statusMessage, etc. Our mock doesn't.
                (this as any).statusCode = statusCode; // Store statusCode for consistency
                return this as ExpressResponse;
            },
            end: function(chunk?: any, encodingOrCb?: string | (() => void), cb?: () => void): ExpressResponse {
                // console.log('Socket MOCK res.end called');
                // This is the method express-session patches.
                // It must exist. If it's called with a callback, invoke it.
                let callback: (() => void) | undefined;
                if (typeof encodingOrCb === 'function') {
                    callback = encodingOrCb;
                } else if (typeof cb === 'function') {
                    callback = cb;
                }
                if (callback) {
                    // Simulating async behavior slightly, though express-session's save is async.
                    // process.nextTick(callback);
                    callback();
                }
                return this as ExpressResponse;
            },
            // express-session might listen for the 'finish' event on the response.
            on: function(event: string, listener: (...args: any[]) => void): ExpressResponse {
                // if (event === 'finish') {
                //     console.log('Socket MOCK res.on("finish") listener attached');
                // }
                return this as ExpressResponse;
            },
            removeListener: function(event: string, listener: (...args: any[]) => void): ExpressResponse {
                return this as ExpressResponse;
            }
            // _header: [], // DO NOT try to mock internal properties like _header directly.
                         // Let Node.js manage it if it's a real ServerResponse.
                         // Our mock's methods (like writeHead, end) need to be careful not to
                         // assume Node.js internal structures if it's purely a mock.
        } as unknown as ExpressResponse; // Cast the mock to ExpressResponse
    }

    middleware(req, resToUse, next as NextFunction);
};


// THE REST OF YOUR socket.ts (configureSockets function) REMAINS THE SAME
// ...
export function configureSockets(io: Server, sessionMiddleware: RequestHandler) {
    io.use(wrap(sessionMiddleware));

    io.use((socket: SocketIOSocket, next: (err?: ExtendedError) => void) => {
        const session = (socket.request as any).session;
        if (session && session.userId) {
            (socket as any).userId = session.userId;
            (socket as any).username = session.username;
            next();
        } else {
            console.log('Socket connection denied: No session or userId');
            next(new Error('Authentication error: Unauthorized'));
        }
    });

    io.on('connection', async (socket: SocketIOSocket) => {
        const userId = (socket as any).userId as number;
        const username = (socket as any).username as string;

        console.log(`User connected to Sockets: ${username} (ID: ${userId}, Socket ID: ${socket.id})`);

        try {
            const historyResult = await pool.query(
                `SELECT m.content, u.username as author, m.created_at
                 FROM messages m
                 JOIN "user" u ON m.author = u.user_id
                 ORDER BY m.created_at DESC
                 LIMIT 20`
            );
            socket.emit('lobby:loadMessages', historyResult.rows.reverse());
        } catch (error) {
            console.error('Error fetching lobby chat history:', error);
        }

        socket.on('lobby:sendMessage', async (data: { message: string }) => {
            const messageContent = data.message.trim();
            if (!messageContent) return;
            const timestamp = new Date();
            try {
                await pool.query(
                    'INSERT INTO messages (content, author, created_at) VALUES ($1, $2, $3)',
                    [messageContent, userId, timestamp]
                );
                const messageData = {
                    username: username,
                    content: messageContent,
                    created_at: timestamp.toISOString(),
                };
                io.emit('lobby:newMessage', messageData);
            } catch (error) {
                console.error('Error saving or broadcasting lobby message:', error);
                socket.emit('lobby:messageError', { error: 'Could not send message.' });
            }
        });

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${username} (ID: ${userId}, Socket ID: ${socket.id})`);
        });

        socket.on('error', (err) => {
            console.error(`Socket error for user ${username} (ID: ${userId}):`, err);
        });
    });

    console.log('Socket.IO configured and listening for connections.');
}
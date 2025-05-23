// src/server/index.ts - Simplified version (keeps optimizations, removes complexity)
import dotenv from "dotenv";
dotenv.config();
import cookieParser from "cookie-parser";
import express, { Request, Response, NextFunction } from "express";
import http from "http";
import httpErrors, { HttpError } from "http-errors";
import morgan from "morgan";
import { Server as IOServer } from "socket.io";
import * as path from "path";
import { rootRoutes, authRoutes, gameRoutes } from "./routes";
import { sessionMiddleware } from "./middleware/session";
import { configureSockets } from "./config/socket";
import initializeDatabase from "./db/init";
import pool from './config/database';

const app = express();
const server = http.createServer(app);

// middleware
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(sessionMiddleware);

// static files
app.use(express.static(path.join(process.cwd(), "src", "public")));
app.use(
  "/client",
  express.static(path.join(process.cwd(), "src", "client"))
);

//  Socket.IO with optimized settings
const io = new IOServer(server, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    cors: {
        origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:3000'],
        methods: ['GET', 'POST'],
        credentials: true
    },
    // timeouts
    pingInterval: 25000,
    pingTimeout: 20000,
});

//  socket handlers 
configureSockets(io, sessionMiddleware);

// this really slows down entering the game view because it connects all our sockets to everywhere, maybe remove it, but it lets you see game creation in real time
app.set('io', io);

// views
app.set("views", path.join(process.cwd(), "src", "server", "views"));
app.set("view engine", "ejs");

// routes
app.use("/", rootRoutes);
app.use("/auth", authRoutes);
app.use("/games", gameRoutes);

// 404 handler 
app.use((req: Request, res: Response, next: NextFunction) => {
  const err = new Error("Not Found");
  (err as any).status = 404;
  next(err);
});

// Error handler 
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  res.status(err.status || 500);
  res.render("error", {
    message: err.message,
    error: process.env.NODE_ENV !== "production" ? err : {}
  });
});

const PORT = process.env.PORT || 3000;

// init db then start server
initializeDatabase().then(() => {
    console.log('Database initialized successfully');
    
    server.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});

// I really wish I knew much about the built in express session before this project...
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    email?: string;
    returnTo?: string;
  }
}
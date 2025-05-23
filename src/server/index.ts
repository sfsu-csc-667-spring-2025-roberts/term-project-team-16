// src/server/index.ts (or your main server file)
import dotenv from "dotenv";
dotenv.config(); // Load environment variables at the very top

import cookieParser from "cookie-parser";
import express, { Request, Response, NextFunction } from "express"; // Added Request, Response, NextFunction for error handler typing
import http from "http";
import httpErrors, { HttpError } from "http-errors"; // Added HttpError for typing
import morgan from "morgan";
import { Server as IOServer } from "socket.io";
import * as path from "path";

// Your existing imports
import { rootRoutes, authRoutes, gameRoutes } from "./routes"; // Assuming this imports { rootRoutes, authRoutes }
import { sessionMiddleware } from "./middleware/session"; // Assuming this is your configured express-session
import { configureSockets } from "./config/socket";
import initializeDatabase from "./db/init"; // Import database initializer
import pool from './config/database'; // Import your database pool if sessionMiddleware needs it directly

const app = express();
const server = http.createServer(app);

// Middleware setup (before socket.io)
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // or true if you need richer objects
app.use(cookieParser());
app.use(sessionMiddleware);

// Static files serving
app.use(express.static(path.join(process.cwd(), "src", "public")));
app.use(
  "/client", // Serves client-side specific build files if any (e.g., bundled JS)
  express.static(path.join(process.cwd(), "src", "client"))
);

// Initialize Socket.IO with proper configuration
const io = new IOServer(server, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    cors: {
        origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:3000'],
        methods: ['GET', 'POST'],
        credentials: true
    },
    pingInterval: 10000,
    pingTimeout: 5000
});

// Configure socket handlers with session middleware
configureSockets(io, sessionMiddleware);

app.set('io', io); // Store io instance for route access
// Set view engine

app.set("views", path.join(process.cwd(), "src", "server", "views"));
app.set("view engine", "ejs");

// Routes setup
app.use("/", rootRoutes);
app.use("/auth", authRoutes);
app.use("/games", gameRoutes); // Your game routes

// 404 handler
app.use((req: Request, res: Response, next: NextFunction) => {
  const err = new Error("Not Found");
  (err as any).status = 404;
  next(err);
});

// error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  res.status(err.status || 500);
  res.render("error", {
    message: err.message,
    error: process.env.NODE_ENV !== "production" ? err : {}
  });
});

const PORT = process.env.PORT || 3000;

// Initialize Database and start server
initializeDatabase().then(() => {
    console.log('Database initialized successfully');
    
    server.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});


// Augment Express Session types
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    email?: string;
    returnTo?: string; // For redirecting after login
    // Add any other custom session properties here
  }
}


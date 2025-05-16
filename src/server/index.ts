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
import * as routes from "./routes"; // Assuming this imports { rootRoutes, authRoutes }
import { sessionMiddleware } from "./middleware/session"; // Assuming this is your configured express-session
import { configureSockets } from "./config/socket";
import initializeDatabase from "./db/init"; // Import database initializer
import pool from './config/database'; // Import your database pool if sessionMiddleware needs it directly

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

// Call configureSockets - ensure it has access to session data if needed
// Often, io needs to use the same session middleware.
// If configureSockets handles this, great. Otherwise, you might pass sessionMiddleware to it or use a shared session store.
configureSockets(io, app);

const PORT = process.env.PORT || 3000;

// Initialize Database First
initializeDatabase().then(() => {
    console.log('Database checked/initialized successfully.');

    // Middleware setup
    app.use(morgan("dev"));
    app.use(express.json());
    app.use(express.urlencoded({ extended: false })); // or true if you need richer objects
    app.use(cookieParser());

    // Static files serving
    app.use(express.static(path.join(process.cwd(), "src", "public")));
    app.use(
      "/client", // Serves client-side specific build files if any (e.g., bundled JS)
      express.static(path.join(process.cwd(), "src", "client"))
    );

    // Session Middleware - ensure this is properly configured with connect-pg-simple and your pool
    // Example: If your sessionMiddleware is a simple export of configured session:
    // import session from 'express-session';
    // import connectPgSimple from 'connect-pg-simple';
    // const PGStore = connectPgSimple(session);
    // export const sessionMiddleware = session({
    //     store: new PGStore({ pool, tableName: 'sessions', createTableIfMissing: true }),
    //     secret: process.env.SESSION_SECRET || 'your-fallback-secret',
    //     resave: false,
    //     saveUninitialized: false,
    //     cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === 'production' }
    // });
    app.use(sessionMiddleware);

    // View engine setup
    app.set("views", path.join(process.cwd(), "src", "server", "views"));
    app.set("view engine", "ejs");

    // Routes
    app.use("/", routes.rootRoutes);
    app.use("/auth", routes.authRoutes); // Your authentication routes

    // Catch 404 and forward to error handler
    app.use((_request: Request, _response: Response, next: NextFunction) => {
      next(httpErrors(404, "Page Not Found"));
    });

    // Error handler (ensure it's the last app.use call)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: HttpError | Error, req: Request, res: Response, _next: NextFunction) => {
        // Set locals, only providing error in development
        res.locals.message = err.message;
        res.locals.error = req.app.get('env') === 'development' ? err : {};

        // Render the error page
        const status = (err as HttpError).status || 500;
        res.status(status);
        res.render('error'); // You'll need an error.ejs view
    });

    server.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });

}).catch(error => {
    console.error('Failed to initialize database or start server:', error);
    process.exit(1); // Exit if critical initialization fails
});


// Augment Express Session types
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    returnTo?: string; // For redirecting after login
    // Add any other custom session properties here
  }
}


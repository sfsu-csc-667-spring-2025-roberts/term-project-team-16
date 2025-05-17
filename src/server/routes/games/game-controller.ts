import express from "express";
import { Request, Response } from "express";
import { Session } from "express-session";
import { RequestHandler } from "express-serve-static-core";
import { QueryResult } from "pg";
import pool from "../../config/database";

interface CustomSession extends Session {
    userId?: number;
}

interface RequestWithSession extends Request {
    session: CustomSession;
}

interface Game {
    game_id: number;
    created_at: Date;
    started_at: Date | null;
    players: Player[];
}

interface Player {
    user_id: number;
    username: string;
}

const router = express.Router();

// Get list of active games
const listGames: RequestHandler = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const offset = (page - 1) * limit;

        // Get total count of games
        const countResult = await pool.query(
            `SELECT COUNT(*) 
            FROM games g 
            WHERE g.started_at IS NULL`
        );
        const totalGames = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalGames / limit);

        // Get paginated games with players
        const result: QueryResult<Game> = await pool.query(
            `SELECT g.*, 
                COALESCE(json_agg(
                    CASE WHEN u.user_id IS NOT NULL 
                    THEN json_build_object(
                        'user_id', u.user_id,
                        'username', u.username
                    )
                    END
                ) FILTER (WHERE u.user_id IS NOT NULL), '[]') as players
            FROM games g
            LEFT JOIN game_players gp ON g.game_id = gp.game_id
            LEFT JOIN "user" u ON gp.user_id = u.user_id
            WHERE g.started_at IS NULL
            GROUP BY g.game_id
            ORDER BY g.created_at DESC
            LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        res.json({
            games: result.rows,
            pagination: {
                currentPage: page,
                totalPages,
                totalGames,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1
            }
        });
    } catch (error) {
        next(error);
    }
};

// Start game
const startGame: RequestHandler = async (req, res, next) => {
    const gameId = req.params.gameId;
    const userId = (req as RequestWithSession).session.userId;

    if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // Check if user is in the game
        const playerCheck = await pool.query(
            "SELECT * FROM game_players WHERE game_id = $1 AND user_id = $2",
            [gameId, userId]
        );

        if (playerCheck.rows.length === 0) {
            res.status(403).json({ error: "Not a player in this game" });
            return;
        }

        // Start the game
        await pool.query(
            "UPDATE games SET started_at = NOW() WHERE game_id = $1 AND started_at IS NULL",
            [gameId]
        );

        res.json({ message: "Game started" });
    } catch (error) {
        next(error);
    }
};

// Join game
const joinGame: RequestHandler = async (req, res, next) => {
    const gameId = req.params.gameId;
    const userId = (req as RequestWithSession).session.userId;

    if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // Check if game exists and hasn't started
        const gameCheck = await pool.query(
            "SELECT * FROM games WHERE game_id = $1 AND started_at IS NULL",
            [gameId]
        );

        if (gameCheck.rows.length === 0) {
            res.status(404).json({ error: "Game not found or already started" });
            return;
        }

        // Check if user is already in the game
        const playerCheck = await pool.query(
            "SELECT * FROM game_players WHERE game_id = $1 AND user_id = $2",
            [gameId, userId]
        );

        if (playerCheck.rows.length > 0) {
            res.status(400).json({ error: "Already joined this game" });
            return;
        }

        // Join the game
        await pool.query(
            "INSERT INTO game_players (game_id, user_id) VALUES ($1, $2)",
            [gameId, userId]
        );

        res.json({ message: "Joined game successfully" });
    } catch (error) {
        next(error);
    }
};

// Create new game
const createGame: RequestHandler = async (req, res, next) => {
    const userId = (req as RequestWithSession).session.userId;

    if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // Create new game
        const result = await pool.query(
            `INSERT INTO games (created_at) 
             VALUES (NOW()) 
             RETURNING game_id`
        );
        
        const gameId = result.rows[0].game_id;

        // Add creator as first player
        await pool.query(
            `INSERT INTO game_players (game_id, user_id) 
             VALUES ($1, $2)`,
            [gameId, userId]
        );

        res.json({ id: gameId });
    } catch (error) {
        next(error);
    }
};

router.get("/", listGames);
router.post("/:gameId/start", startGame);
router.post("/:gameId/join", joinGame);
router.post("/", createGame);

export default router;

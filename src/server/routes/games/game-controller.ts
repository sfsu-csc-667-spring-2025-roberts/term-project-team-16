import express, { Request, Response, NextFunction } from "express";
import { Session } from "express-session";
import { RequestHandler } from "express-serve-static-core";
import { QueryResult } from "pg";
import pool from "../../config/database";

interface CustomSession extends Session {
    userId?: number;
    username?: string;
}

interface RequestWithSession extends Request {
    session: CustomSession;
}

interface Game {
    game_id: number;
    max_num_players: number;
    current_num_players: number;
    state: string;
    players: Player[];
}

interface Player {
    user_id: number;
    username: string;
}

const router = express.Router();

// GET: List all active games (lobby)
const listGames: RequestHandler = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const offset = (page - 1) * limit;

        // Get total count of all active games (waiting or playing)
        const countResult = await pool.query(
            `SELECT COUNT(*) FROM game WHERE state IN ('waiting', 'playing')`
        );
        const totalGames = parseInt(countResult.rows[0].count);
        const totalPages = Math.max(1, Math.ceil(totalGames / limit));

        // Get paginated games with players (matching schema)
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
            FROM game g
            LEFT JOIN game_players gp ON g.game_id = gp.game_id
            LEFT JOIN "user" u ON gp.user_id = u.user_id
            WHERE g.state IN ('waiting', 'playing')
            GROUP BY g.game_id
            ORDER BY g.game_id DESC
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
                hasPrevPage: page > 1,
            },
        });
    } catch (error) {
        next(error);
    }
};

// GET: Render the game page for a specific game
router.get("/:gameId", async (req: RequestWithSession, res: Response, next: NextFunction) => {
    try {
        const { gameId } = req.params;
        const userId = req.session.userId;
        const username = req.session.username;

        if (!userId) {
            return res.redirect("/auth/login");
        }

        res.render("game", {
            gameId,
            username,
        });
    } catch (error) {
        next(error);
    }
});

// POST: Start a game
const startGame: RequestHandler = async (req, res, next) => {
    const gameId = req.params.gameId;
    const userId = (req as RequestWithSession).session.userId;

    if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // Make sure user is a player in the game
        const playerCheck = await pool.query(
            "SELECT * FROM game_players WHERE game_id = $1 AND user_id = $2",
            [gameId, userId]
        );

        if (playerCheck.rows.length === 0) {
            res.status(403).json({ error: "Not a player in this game" });
            return;
        }

        // Start the game (change state to 'playing')
        await pool.query(
            "UPDATE game SET state = 'playing' WHERE game_id = $1 AND state = 'waiting'",
            [gameId]
        );

        res.json({ message: "Game started" });
    } catch (error) {
        next(error);
    }
};

// POST: Join a game
const joinGame: RequestHandler = async (req, res, next) => {
    const gameId = req.params.gameId;
    const userId = (req as RequestWithSession).session.userId;

    if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // Check if game exists and is waiting
        const gameCheck = await pool.query(
            "SELECT * FROM game WHERE game_id = $1 AND state = 'waiting'",
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
            // User is already in the game, let them rejoin
            res.json({ message: "Rejoined game successfully" });
            return;
        }

        // Get next position for the player (0-based)
        const positionResult = await pool.query(
            "SELECT COUNT(*) FROM game_players WHERE game_id = $1",
            [gameId]
        );
        const nextPosition = parseInt(positionResult.rows[0].count, 10);

        // Join the game (add to players table)
        await pool.query(
            "INSERT INTO game_players (game_id, user_id, position) VALUES ($1, $2, $3)",
            [gameId, userId, nextPosition]
        );

        // Update player count
        await pool.query(
            "UPDATE game SET current_num_players = current_num_players + 1 WHERE game_id = $1",
            [gameId]
        );

        res.json({ message: "Joined game successfully" });
    } catch (error) {
        next(error);
    }
};

// POST: Create a new game
const createGame: RequestHandler = async (req, res, next) => {
    const userId = (req as RequestWithSession).session.userId;

    if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // Create new game, set yourself as the first player
        const result = await pool.query(
            `INSERT INTO game (max_num_players, current_num_players, state) 
             VALUES ($1, $2, $3)
             RETURNING game_id`,
            [4, 1, 'waiting'] // Default max players to 4, current to 1
        );
        
        const gameId = result.rows[0].game_id;

        // Add creator as first player, position 0
        await pool.query(
            `INSERT INTO game_players (game_id, user_id, position) 
             VALUES ($1, $2, $3)`,
            [gameId, userId, 0]
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
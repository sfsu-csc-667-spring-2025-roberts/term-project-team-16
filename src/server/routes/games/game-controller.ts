import express, { Request, Response, NextFunction } from "express";
import { Session } from "express-session";
import { RequestHandler } from "express-serve-static-core";
import { QueryResult } from "pg";
import { Server as IOServer } from "socket.io";
import pool from "../../config/database";
//yes our whole API is in websockets, I basically followed along lectures with AI for the lobby chat sockets and then made something similar for the game logic
//and yes this would be a nightmare to convert to other cardgames or besides the turn structure, maintain, or secure, but I learned stuff
//also I would rather move to my next project and continue job applying than make this project better
//  I already have like 20 webapps to put on my resume and my first typescript one is a nightmare
//  at this point I'd just be cutting stuff off and refactoring into api routes

//types
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

interface GameState {
    id: string;
    players: string[];
    state: 'waiting' | 'playing' | 'ended';
    createdAt: Date;
}

const router = express.Router();

// Helper function to get IO instance from app
function getIOInstance(req: Request): IOServer | null {
    const app = req.app as any;
    return app.get('io') || null;
}

// Helper function to format game data for socket events
function formatGameForSocket(game: any): GameState {
    return {
        id: game.game_id.toString(),
        players: game.players ? game.players.map((p: Player) => p.username) : [],
        state: game.state,
        createdAt: new Date()
    };
}

// Helper function to get game with players from database
async function getGameWithPlayers(gameId: string | number) {
    const result = await pool.query(
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
        WHERE g.game_id = $1
        GROUP BY g.game_id`,
        [gameId]
    );
    return result.rows[0];
}

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
    const io = getIOInstance(req);

    if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // make sure we have players in game
        const playerCheck = await pool.query(
            "SELECT * FROM game_players WHERE game_id = $1 AND user_id = $2",
            [gameId, userId]
        );

        if (playerCheck.rows.length === 0) {
            res.status(403).json({ error: "Not a player in this game" });
            return;
        }

        // update game state
        const updateResult = await pool.query(
            "UPDATE game SET state = 'playing' WHERE game_id = $1 AND state = 'waiting' RETURNING *",
            [gameId]
        );

        if (updateResult.rows.length === 0) {
            res.status(400).json({ error: "Game not found or already started" });
            return;
        }

        // Get updated game data and emit socket event
        if (io) {
            const gameData = await getGameWithPlayers(gameId);
            const socketData = formatGameForSocket(gameData);
            io.emit('game:stateChanged', {
                gameId: gameId,
                state: 'playing',
                players: socketData.players
            });
        }

        res.json({ message: "Game started" });
    } catch (error) {
        next(error);
    }
};

// join a game, this might be a little server heavy, I really don't know cause I've never made a lot of websockets...
const joinGame: RequestHandler = async (req, res, next) => {
    const gameId = req.params.gameId;
    const userId = (req as RequestWithSession).session.userId;
    const username = (req as RequestWithSession).session.username;
    const io = getIOInstance(req);

    if (!userId || !username) {
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
            res.json({ message: "Already in game" });
            return;
        }

        // Check if game is full
        const currentPlayerCount = await pool.query(
            "SELECT COUNT(*) as count FROM game_players WHERE game_id = $1",
            [gameId]
        );

        if (parseInt(currentPlayerCount.rows[0].count) >= 4) {
            res.status(400).json({ error: "Game is full" });
            return;
        }

        // Get next position for the player (0-based)
        const nextPosition = parseInt(currentPlayerCount.rows[0].count);

        // Begin transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Join the game (add to players table)
            await client.query(
                "INSERT INTO game_players (game_id, user_id, position) VALUES ($1, $2, $3)",
                [gameId, userId, nextPosition]
            );

            // Update player count
            await client.query(
                "UPDATE game SET current_num_players = current_num_players + 1 WHERE game_id = $1",
                [gameId]
            );

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

        // Get updated game data and emit socket event
        if (io) {
            const gameData = await getGameWithPlayers(gameId);
            const socketData = formatGameForSocket(gameData);
            
            io.emit('game:joined', {
                gameId: gameId,
                players: socketData.players,
                state: gameData.state
            });
        }

        res.json({ message: "Joined game successfully" });
    } catch (error) {
        next(error);
    }
};

// POST: Create a new game
const createGame: RequestHandler = async (req, res, next) => {
    const userId = (req as RequestWithSession).session.userId;
    const username = (req as RequestWithSession).session.username;
    const io = getIOInstance(req);

    if (!userId || !username) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // Begin transaction
        const client = await pool.connect();
        let gameId: number;
        
        try {
            await client.query('BEGIN');

            // Create new game, set yourself as the first player
            const gameResult = await client.query(
                `INSERT INTO game (max_num_players, current_num_players, state) 
                 VALUES ($1, $2, $3)
                 RETURNING game_id`,
                [4, 1, 'waiting'] // Default max players to 4, current to 1
            );
            
            gameId = gameResult.rows[0].game_id;

            // Add creator as first player, position 0
            await client.query(
                `INSERT INTO game_players (game_id, user_id, position) 
                 VALUES ($1, $2, $3)`,
                [gameId, userId, 0]
            );

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

        // actual game start code
        // Emit socket event for real-time updates
        if (io) {
            const newGameData: GameState = {
                id: gameId.toString(),
                players: [username],
                state: 'waiting',
                createdAt: new Date()
            };
            
            io.emit('game:created', newGameData);
        }

        res.json({ id: gameId });
    } catch (error) {
        next(error);
    }
};

// POST: End a game - New endpoint to properly end games
const endGame: RequestHandler = async (req, res, next) => {
    const gameId = req.params.gameId;
    const userId = (req as RequestWithSession).session.userId;
    const io = getIOInstance(req);

    if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }

    try {
        // Check if user is in the game (could add additional authorization here)
        const playerCheck = await pool.query(
            "SELECT * FROM game_players WHERE game_id = $1 AND user_id = $2",
            [gameId, userId]
        );

        if (playerCheck.rows.length === 0) {
            res.status(403).json({ error: "Not a player in this game" });
            return;
        }

        // Update game state
        await pool.query(
            "UPDATE game SET state = 'ended' WHERE game_id = $1",
            [gameId]
        );

        // Emit socket event
        if (io) {
            io.emit('game:ended', { gameId: gameId });
        }

        res.json({ message: "Game ended successfully" });
    } catch (error) {
        next(error);
    }
};

// Route definitions
router.get("/", listGames);
//router.get("/:gameId", router.get("/:gameId")); if you just comment out AI-driven bugs it's like they dont happen
router.post("/", createGame);
router.post("/:gameId/join", joinGame);
router.post("/:gameId/start", startGame);
router.post("/:gameId/end", endGame); // new endpoint

export default router;
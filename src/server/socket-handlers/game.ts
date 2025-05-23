// src/server/socket-handlers/game.ts - Complete final version
import { Server as IOServer } from "socket.io";
import pool from "../config/database";
import { AugmentedSocket } from "../config/socket";

// Interfaces
interface ChatMessage {
    content: string;
    username: string;
    created_at: Date;
    game_id: string;
}

interface Card {
    card_id: number;
    value: number;
    shape: string;
}

interface PlayerState {
    userId: number;
    username: string;
    position: number;
    card_count: number;
    isCurrentTurn: boolean;
    isWinner?: boolean; 
}

interface LastPlayInfo {
    gamePlayerId: number;
    playerPosition: number;
    cardsPlayed: Card[];
    declaredRank: string;
    cardCount: number;
    timestamp: number;
}

interface GameStateForClient {
    gameId: string;
    gameState: {
        state: string;
        current_num_players: number;
    };
    players: PlayerState[];
    currentTurnPosition: number;
    lastPlay: LastPlayInfo | null;
    hand?: Card[];
    yourPosition?: number;
    pileCardCount: number;
    pendingWin?: {
        playerPosition: number;
        playerUsername: string;
        timeRemaining: number;
    };
    isMyTurn?: boolean;
    requiredRank?: string | null; // null when pile is empty (player chooses)
}

// Game state management with better structure
class GameStateManager {
    private static gameWinTimers = new Map<string, NodeJS.Timeout>();
    private static gamePendingWins = new Map<string, { playerPosition: number; playerUsername: string; startTime: number }>();
    private static activeGamePiles = new Map<string, Card[]>();
    private static gameLastPlayInfo = new Map<string, LastPlayInfo>();

    static getGamePile(gameId: string): Card[] {
        return this.activeGamePiles.get(gameId) || [];
    }

    static setGamePile(gameId: string, pile: Card[]): void {
        this.activeGamePiles.set(gameId, pile);
    }

    static getLastPlay(gameId: string): LastPlayInfo | null {
        return this.gameLastPlayInfo.get(gameId) || null;
    }

    static setLastPlay(gameId: string, play: LastPlayInfo): void {
        this.gameLastPlayInfo.set(gameId, play);
    }

    static clearLastPlay(gameId: string): void {
        this.gameLastPlayInfo.delete(gameId);
    }

    static setWinTimer(gameId: string, timer: NodeJS.Timeout): void {
        this.clearWinTimer(gameId);
        this.gameWinTimers.set(gameId, timer);
    }

    static clearWinTimer(gameId: string): void {
        const timer = this.gameWinTimers.get(gameId);
        if (timer) {
            clearTimeout(timer);
            this.gameWinTimers.delete(gameId);
        }
    }

    static setPendingWin(gameId: string, pendingWin: { playerPosition: number; playerUsername: string; startTime: number }): void {
        this.gamePendingWins.set(gameId, pendingWin);
    }

    static getPendingWin(gameId: string): { playerPosition: number; playerUsername: string; startTime: number } | null {
        return this.gamePendingWins.get(gameId) || null;
    }

    static clearPendingWin(gameId: string): void {
        this.gamePendingWins.delete(gameId);
    }

    static cleanupGame(gameId: string): void {
        this.clearWinTimer(gameId);
        this.clearPendingWin(gameId);
        this.activeGamePiles.delete(gameId);
        this.gameLastPlayInfo.delete(gameId);
    }
}

// Helper functions for rank management
function getNextRequiredRank(gameId: string): string | null {
    const pile = GameStateManager.getGamePile(gameId);
    
    // If no cards in pile, player can choose any rank (return null to show dropdown)
    if (pile.length === 0) {
        return null; // This will show the declaration dropdown
    }
    
    // If there are cards in pile, get the next rank in sequence
    const lastPlay = GameStateManager.getLastPlay(gameId);
    if (lastPlay) {
        return getNextRankInSequence(lastPlay.declaredRank);
    }
    
    // Fallback (shouldn't happen if pile has cards)
    return 'A';
}

function getNextRankInSequence(currentRank: string): string {
    const rankSequence = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const currentIndex = rankSequence.indexOf(currentRank);
    
    if (currentIndex === -1) {
        return 'A'; // Fallback if invalid rank
    }
    
    // Wrap around to start after King
    const nextIndex = (currentIndex + 1) % rankSequence.length;
    return rankSequence[nextIndex];
}

function rankToValue(rank: string): number {
    const rankMap: { [key: string]: number } = {
        'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
        '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13
    };
    return rankMap[rank] || 1;
}

// Optimized database queries
async function getPlayerGamePlayerId(gameId: string, userId: number): Promise<number | null> {
    const gameIdInt = parseInt(gameId, 10);
    if (isNaN(gameIdInt)) {
        console.error(`[GameTS:getPlayerGamePlayerId] Invalid gameId format: ${gameId}`);
        return null;
    }
    const res = await pool.query(
        `SELECT game_player_id FROM game_players WHERE game_id = $1 AND user_id = $2`,
        [gameIdInt, userId]
    );
    return res.rows.length > 0 ? res.rows[0].game_player_id : null;
}

async function getPlayerHand(gamePlayerId: number): Promise<Card[]> {
    const handRes = await pool.query(
        `SELECT c.card_id, c.value, c.shape 
         FROM cards_held ch 
         JOIN card c ON ch.card_id = c.card_id 
         WHERE ch.game_player_id = $1 
         ORDER BY c.value, c.shape`,
        [gamePlayerId]
    );
    return handRes.rows;
}

// Optimized game state fetching with fewer queries
async function fetchFullGameStateForClient(gameId: string, targetUserId?: number): Promise<GameStateForClient | null> {
    const gameIdInt = parseInt(gameId, 10);
    if (isNaN(gameIdInt)) {
        console.error(`[GameTS:fetchFullGameState] Invalid gameId format: ${gameId}`);
        return null;
    }

    // Single query to get game info and all players
    const gameAndPlayersResult = await pool.query(
        `SELECT 
            g.state, g.current_num_players,
            gp.user_id, u.username, gp.position, gp.is_turn, 
            gp.game_player_id, gp.is_winner,
            (SELECT COUNT(*) FROM cards_held ch WHERE ch.game_player_id = gp.game_player_id) as card_count
         FROM game g
         LEFT JOIN game_players gp ON g.game_id = gp.game_id
         LEFT JOIN "user" u ON gp.user_id = u.user_id
         WHERE g.game_id = $1
         ORDER BY gp.position`,
        [gameIdInt]
    );

    if (gameAndPlayersResult.rows.length === 0) {
        console.warn(`[GameTS:fetchFullGameState] Game not found in DB: ${gameIdInt}`);
        return null;
    }

    const gameDbState = {
        state: gameAndPlayersResult.rows[0].state,
        current_num_players: gameAndPlayersResult.rows[0].current_num_players
    };

    const players: PlayerState[] = gameAndPlayersResult.rows
        .filter(row => row.user_id) // Filter out null users
        .map(p => ({
            userId: p.user_id,
            username: p.username,
            position: p.position,
            card_count: parseInt(p.card_count, 10),
            isCurrentTurn: p.is_turn && !p.is_winner,
            isWinner: p.is_winner
        }));

    const currentTurnPosition = players.find(p => p.isCurrentTurn)?.position ?? -1;

    const pile = GameStateManager.getGamePile(gameId);
    const lastPlay = GameStateManager.getLastPlay(gameId);
    const requiredRank = getNextRequiredRank(gameId); // null if pile is empty, string if pile has cards

    const gameState: GameStateForClient = {
        gameId,
        gameState: gameDbState,
        players,
        currentTurnPosition,
        lastPlay,
        pileCardCount: pile.length,
        requiredRank
    };

    // Add pending win info if game is in pending_win state
    if (gameDbState.state === 'pending_win') {
        const pendingWin = GameStateManager.getPendingWin(gameId);
        if (pendingWin) {
            const timeElapsed = (Date.now() - pendingWin.startTime) / 1000;
            const timeRemaining = Math.max(0, 15 - timeElapsed);
            gameState.pendingWin = {
                playerPosition: pendingWin.playerPosition,
                playerUsername: pendingWin.playerUsername,
                timeRemaining: Math.round(timeRemaining)
            };
        }
    }

    // Add player-specific data if targetUserId provided
    if (targetUserId) {
        const playerInfo = players.find(p => p.userId === targetUserId);
        if (playerInfo) {
            gameState.yourPosition = playerInfo.position;
            gameState.isMyTurn = playerInfo.isCurrentTurn;
            // Only fetch hand if needed
            const gamePlayerRow = gameAndPlayersResult.rows.find(row => row.user_id === targetUserId);
            if (gamePlayerRow?.game_player_id) {
                gameState.hand = await getPlayerHand(gamePlayerRow.game_player_id);
            }
        }
    }

    return gameState;
}

async function broadcastGameState(io: IOServer, gameId: string) {
    const allPlayersState = await fetchFullGameStateForClient(gameId);
    if (!allPlayersState?.players) {
        console.error(`[GameTS:broadcastGameState] Failed to fetch game state for broadcast, gameId: ${gameId}`);
        return;
    }

    // Batch the user-specific queries
    const userPromises = allPlayersState.players.map(async (player) => {
        const specificGameState = await fetchFullGameStateForClient(gameId, player.userId);
        if (specificGameState) {
            return { userId: player.userId, gameState: specificGameState };
        }
        return null;
    });

    const results = await Promise.allSettled(userPromises);
    
    results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
            const { userId, gameState } = result.value;
            io.to(`user:${userId}`).emit('game:stateUpdate', gameState);
        } else {
            console.error(`[GameTS:broadcastGameState] Failed to send state to player ${allPlayersState.players[index].userId}`);
        }
    });
}

// Improved turn advancement with better error handling
async function advanceTurn(gameId: string): Promise<number> {
    const client = await pool.connect();
    const gameIdInt = parseInt(gameId, 10);
    
    try {
        await client.query('BEGIN');
        
        // Get current turn player and all active players in one query
        const gameStateResult = await client.query(
            `SELECT 
                g.state as game_state,
                COALESCE(
                    (SELECT position FROM game_players WHERE game_id = $1 AND is_turn = TRUE AND is_winner = FALSE), 
                    -1
                ) as current_position,
                ARRAY_AGG(gp.position ORDER BY gp.position) as active_positions
             FROM game g
             LEFT JOIN game_players gp ON g.game_id = gp.game_id AND gp.is_winner = FALSE
             WHERE g.game_id = $1
             GROUP BY g.state`,
            [gameIdInt]
        );

        if (gameStateResult.rows.length === 0) {
            throw new Error(`Game ${gameIdInt} not found`);
        }

        const { game_state, current_position, active_positions } = gameStateResult.rows[0];
        const activePlayerPositions = active_positions.filter((pos: number) => pos !== null);

        if (activePlayerPositions.length === 0) {
            console.warn(`[GameTS:advanceTurn] No active players in game ${gameIdInt}`);
            await client.query('COMMIT');
            return -1;
        }

        // Clear current turn
        if (current_position !== -1) {
            await client.query(
                `UPDATE game_players SET is_turn = FALSE WHERE game_id = $1 AND position = $2`,
                [gameIdInt, current_position]
            );
        }

        // Calculate next position
        let nextPosition = activePlayerPositions[0]; // Default to first player
        if (current_position !== -1) {
            const currentIndex = activePlayerPositions.indexOf(current_position);
            if (currentIndex !== -1) {
                nextPosition = activePlayerPositions[(currentIndex + 1) % activePlayerPositions.length];
            } else {
                // Current player not in active list, find next higher position or wrap around
                const higherPositions = activePlayerPositions.filter((pos: number) => pos > current_position);
                nextPosition = higherPositions.length > 0 ? higherPositions[0] : activePlayerPositions[0];
            }
        }

        // Set next turn
        const nextPlayerResult = await client.query(
            `UPDATE game_players SET is_turn = TRUE 
             WHERE game_id = $1 AND position = $2 AND is_winner = FALSE 
             RETURNING user_id`,
            [gameIdInt, nextPosition]
        );

        if (nextPlayerResult.rowCount === 0) {
            throw new Error(`Failed to set turn for position ${nextPosition} in game ${gameIdInt}`);
        }

        await client.query('COMMIT');
        console.log(`[GameTS:advanceTurn] Turn advanced to position ${nextPosition} in game ${gameIdInt}`);
        return nextPosition;
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[GameTS:advanceTurn] Error in game ${gameIdInt}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

// Improved win finalization
async function finalizePlayerWin(io: IOServer, gameId: string, winnerGamePlayerId: number, winnerPosition: number, winnerUsername: string) {
    const gameIdInt = parseInt(gameId, 10);
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Update game and player states in batch
        await Promise.all([
            client.query(`UPDATE game SET state = 'ended' WHERE game_id = $1`, [gameIdInt]),
            client.query(`UPDATE game_players SET is_winner = TRUE, is_turn = FALSE WHERE game_player_id = $1`, [winnerGamePlayerId]),
            client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1 AND game_player_id != $2`, [gameIdInt, winnerGamePlayerId])
        ]);
        
        await client.query('COMMIT');
        
        // Clean up all game state
        GameStateManager.cleanupGame(gameId);
        
        // Emit events
        const gameOverData = {
            winnerPosition,
            winnerUsername,
            message: `Player ${winnerUsername} (P${winnerPosition + 1}) has won the game!`
        };

        io.to(`game:${gameId}`).emit('game:gameOver', gameOverData);
        io.emit('game:ended', { gameId });
        
        console.log(`[GameTS:finalizePlayerWin] Game ${gameId} ended with winner: ${winnerUsername}`);
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[GameTS:finalizePlayerWin] Error finalizing win for game ${gameId}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

export default function handleGameConnection(io: IOServer, socket: AugmentedSocket): void {
    console.log(`[GameTS:handleGameConnection] Initializing for socketId=${socket.id}, userId=${socket.userId || 'N/A'}, username=${socket.username || 'N/A'}`);

    socket.on('game:join-room', async ({ gameId }, callback) => {
        console.log(`[GameTS:join-room EVENT] SocketId=${socket.id}. CHECKING AUTH: userId=${socket.userId}, username=${socket.username}. GameId=${gameId}`);
        
        if (!socket.userId || !socket.username) { 
            console.warn(`[GameTS:join-room AUTH_FAIL] Unauthorized attempt for game ${gameId} by socket ${socket.id}. userId is ${socket.userId}, username is ${socket.username}.`);
            return callback?.({ error: 'Not authenticated.' });
        }
        try {
            socket.join(`game:${gameId}`);
            console.log(`[GameTS:join-room SUCCESS] User ${socket.username} (userId ${socket.userId}) joined room game:${gameId}.`);
            
            const gameState = await fetchFullGameStateForClient(gameId, socket.userId);
            if (!gameState) {
                console.error(`[GameTS:join-room] Game ${gameId} not found for user ${socket.username}.`);
                return callback?.({ error: 'Game not found or failed to fetch state.' });
            }
            
            socket.emit('game:stateUpdate', gameState);
            await broadcastGameState(io, gameId); 
            callback?.({ success: true });
        } catch (error: any) {
            console.error(`[GameTS:join-room] Error for ${socket.username} (userId ${socket.userId}) joining game ${gameId}:`, error.message);
            callback?.({ error: 'Server error joining room.' });
        }
    });

    socket.on('game:leave-room', ({ gameId }, callback) => {
        socket.leave(`game:${gameId}`);
        console.log(`[GameTS:leave-room] Socket ${socket.id} (userId ${socket.userId || 'N/A'}) left room game:${gameId}.`);
        callback?.({ success: true });
    });

    socket.on('game:sendMessage', async ({ gameId, message }, callback) => {
        if (!socket.userId || !socket.username) return callback?.({ error: 'Not authenticated.' });
        const trimmedMessage = message.trim();
        if (!trimmedMessage || trimmedMessage.length > 500) return callback?.({ error: 'Invalid message.' });
        try {
            const gameIdInt = parseInt(gameId, 10);
            const result = await pool.query( `INSERT INTO messages (content, author, game_id, created_at) VALUES ($1, $2, $3, NOW()) RETURNING created_at`, [trimmedMessage, socket.userId, gameIdInt]);
            const messageData: ChatMessage = { content: trimmedMessage, username: socket.username || 'Anonymous', created_at: result.rows[0].created_at, game_id: gameId };
            io.to(`game:${gameId}`).emit('game:newMessage', messageData);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:sendMessage] Error for ${socket.username || 'unknown user'} in game ${gameId}:`, error);
            callback?.({ error: 'Failed to send message.' });
        }
    });

    socket.on('game:loadMessages', async ({ gameId }, callback) => {
        if (!socket.userId) return callback?.({ error: 'Not authenticated.' });
        try {
            const gameIdInt = parseInt(gameId, 10);
            const result = await pool.query( `SELECT m.content, u.username, m.created_at FROM messages m JOIN "user" u ON m.author = u.user_id WHERE m.game_id = $1 ORDER BY m.created_at ASC LIMIT 50`, [gameIdInt]);
            socket.emit('game:loadMessages', result.rows);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:loadMessages] Error for game ${gameId}:`, error);
            callback?.({ error: 'Failed to load messages.' });
        }
    });

    socket.on('game:start', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) return callback?.({ error: 'Not authenticated.' });
        const gameIdInt = parseInt(gameId, 10);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const playerCheck = await client.query('SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2', [gameIdInt, socket.userId]);
            if (playerCheck.rows.length === 0) { await client.query('ROLLBACK'); return callback?.({ error: 'You are not a player in this game.' }); }

            const gameRes = await client.query('SELECT state, current_num_players FROM game WHERE game_id = $1 FOR UPDATE', [gameIdInt]);
            if (!gameRes.rows.length) throw new Error('Game not found.');
            if (gameRes.rows[0].state !== 'waiting') throw new Error('Game already started or ended.');
            if (gameRes.rows[0].current_num_players < 2) throw new Error('Not enough players (min 2).');

            await client.query(`UPDATE game SET state = 'playing' WHERE game_id = $1`, [gameIdInt]);
            const playersInGameRes = await client.query(`SELECT gp.game_player_id, gp.user_id, gp.position FROM game_players gp WHERE gp.game_id = $1 ORDER BY gp.position`, [gameIdInt]);
            const playersInGame = playersInGameRes.rows;
            if (playersInGame.length === 0) throw new Error("No players found for this game.");

            const cardsRes = await client.query('SELECT card_id, value, shape FROM card');
            let deck: Card[] = cardsRes.rows;
            deck = deck.sort(() => Math.random() - 0.5);

            const gamePlayerIds = playersInGame.map(p => p.game_player_id);
            await client.query(`DELETE FROM cards_held WHERE game_player_id = ANY($1::int[])`, [gamePlayerIds]);
            await client.query(`UPDATE game_players SET is_winner = FALSE, is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);

            const cardsToDealTotal = Math.min(52, deck.length);
            for (let i = 0; i < cardsToDealTotal; i++) {
                const playerToReceive = playersInGame[i % playersInGame.length];
                const cardToDeal = deck.shift();
                if (cardToDeal) await client.query('INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)', [playerToReceive.game_player_id, cardToDeal.card_id]);
                else break;
            }
            GameStateManager.setGamePile(gameId, []);
            GameStateManager.clearLastPlay(gameId);

            const firstPlayer = playersInGame.find(p => p.position === 0);
            if (firstPlayer) await client.query(`UPDATE game_players SET is_turn = TRUE WHERE game_player_id = $1`, [firstPlayer.game_player_id]);
            else if (playersInGame.length > 0) await client.query(`UPDATE game_players SET is_turn = TRUE WHERE game_player_id = $1`, [playersInGame[0].game_player_id]);
            
            await client.query('COMMIT');
            console.log(`[GameTS:start] Game ${gameId} started by ${socket.username || 'unknown user'}.`);
            await broadcastGameState(io, gameId);
            callback?.({ success: true });
        } catch (error: any) {
            await client.query('ROLLBACK');
            console.error(`[GameTS:start] Error starting game ${gameId}:`, error);
            callback?.({ error: error.message || 'Failed to start game.' });
        } finally {
            client.release();
        }
    });

    socket.on('game:playCards', async ({ gameId, cardsToPlayIds, declaredRank }, callback) => {
        if (!socket.userId || !socket.username) return callback?.({ error: 'Not authenticated.' });
        if (!Array.isArray(cardsToPlayIds) || cardsToPlayIds.length === 0) return callback?.({ error: 'No cards selected.' });
        
        const gameIdInt = parseInt(gameId, 10);
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // Get player info and game state
            const playerGameResult = await client.query(
                `SELECT 
                    gp.game_player_id, gp.position, gp.is_turn, g.state as game_state
                 FROM game_players gp 
                 JOIN game g ON gp.game_id = g.game_id 
                 WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameIdInt, socket.userId]
            );

            if (!playerGameResult.rows.length) throw new Error('Player not found in this game.');
            
            const { game_player_id: gamePlayerId, position: playerPosition, is_turn: isTurn, game_state: gameState } = playerGameResult.rows[0];
            
            if (gameState !== 'playing') throw new Error('Game is not currently in playing state.');
            if (!isTurn) throw new Error("Not your turn.");

            // Determine what rank should be played
            const pile = GameStateManager.getGamePile(gameId);
            let finalDeclaredRank: string;
            
            if (pile.length === 0) {
                // Empty pile - player must declare a rank
                if (!declaredRank || typeof declaredRank !== 'string') {
                    throw new Error('You must declare a rank when the pile is empty.');
                }
                finalDeclaredRank = declaredRank;
            } else {
                // Cards in pile - server determines next rank automatically
                const requiredRank = getNextRequiredRank(gameId);
                if (!requiredRank) {
                    throw new Error('Unable to determine required rank.');
                }
                finalDeclaredRank = requiredRank;
            }

            // Validate and remove cards from hand
            const cardValidationPromises = cardsToPlayIds.map(async (cardIdStr: string) => {
                const cardId = parseInt(cardIdStr, 10);
                if (isNaN(cardId)) throw new Error(`Invalid card ID: ${cardIdStr}`);
                
                const cardRes = await client.query(
                    `DELETE FROM cards_held 
                     WHERE game_player_id = $1 AND card_id = $2 
                     RETURNING (SELECT value FROM card WHERE card_id = $2) as value,
                              (SELECT shape FROM card WHERE card_id = $2) as shape`,
                    [gamePlayerId, cardId]
                );
                
                if (cardRes.rowCount === 0) throw new Error(`Card ${cardId} not in your hand`);
                return { card_id: cardId, value: cardRes.rows[0].value, shape: cardRes.rows[0].shape };
            });

            const playedCards = await Promise.all(cardValidationPromises);
            
            // Update game state
            pile.push(...playedCards);
            GameStateManager.setGamePile(gameId, pile);
            
            // Store play info with the final declared rank
            const playInfo: LastPlayInfo = {
                gamePlayerId,
                playerPosition,
                cardsPlayed: playedCards,
                declaredRank: finalDeclaredRank,
                cardCount: cardsToPlayIds.length,
                timestamp: Date.now()
            };
            GameStateManager.setLastPlay(gameId, playInfo);
            
            // Check remaining cards and handle win condition
            const remainingCardsCount = await client.query(
                `SELECT COUNT(*) as count FROM cards_held WHERE game_player_id = $1`,
                [gamePlayerId]
            );
            const cardsLeft = parseInt(remainingCardsCount.rows[0].count, 10);
            
            if (cardsLeft === 0) {
                // Enter pending win state
                await client.query(`UPDATE game SET state = 'pending_win' WHERE game_id = $1`, [gameIdInt]);
                await client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);
                
                const pendingWinInfo = {
                    playerPosition,
                    playerUsername: socket.username || `P${playerPosition + 1}`,
                    startTime: Date.now()
                };
                GameStateManager.setPendingWin(gameId, pendingWinInfo);
                
                // Set 15-second auto-win timer
                const winTimer = setTimeout(async () => {
                    try {
                        await finalizePlayerWin(io, gameId, gamePlayerId, playerPosition, socket.username || `P${playerPosition + 1}`);
                        await broadcastGameState(io, gameId);
                    } catch (error) {
                        console.error(`[GameTS:winTimer] Error in auto-win for game ${gameId}:`, error);
                    }
                }, 15000);
                
                GameStateManager.setWinTimer(gameId, winTimer);
                
                io.to(`game:${gameId}`).emit('game:pendingWin', {
                    playerPosition,
                    playerUsername: socket.username || `P${playerPosition + 1}`,
                    timeWindow: 15,
                    message: `${socket.username || `P${playerPosition + 1}`} played their last card! Call BS within 15 seconds or they win!`
                });
            } else {
                // Normal play - advance turn
                await advanceTurn(gameId);
            }
            
            await client.query('COMMIT');
            
            io.to(`game:${gameId}`).emit('game:actionPlayed', {
                type: 'play',
                playerPosition,
                username: socket.username || `P${playerPosition + 1}`,
                cardCount: cardsToPlayIds.length,
                declaredRank: finalDeclaredRank
            });
            
            await broadcastGameState(io, gameId);
            callback?.({ success: true });
            
        } catch (error: any) {
            await client.query('ROLLBACK');
            console.error(`[GameTS:playCards] Error for ${socket.username} in game ${gameId}:`, error);
            callback?.({ error: error.message || 'Failed to play cards.' });
        } finally {
            client.release();
        }
    });

    // BS call handler with CORRECT turn logic - pile receiver gets turn, dropdown appears
    socket.on('game:callBS', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) return callback?.({ error: 'Not authenticated.' });
        
        const gameIdInt = parseInt(gameId, 10);
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const playerInfoRes = await client.query(
                `SELECT gp.game_player_id, gp.position, g.state as game_state 
                 FROM game_players gp JOIN game g ON gp.game_id = g.game_id 
                 WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameIdInt, socket.userId]
            );
            
            if (!playerInfoRes.rows.length) throw new Error('Caller not found in this game.');
            
            const { game_player_id: callerGamePlayerId, position: callerPosition, game_state: gameState } = playerInfoRes.rows[0];
            
            if (gameState !== 'playing' && gameState !== 'pending_win') {
                throw new Error('Game is not in a state where BS can be called.');
            }

            const lastPlay = GameStateManager.getLastPlay(gameId);
            if (!lastPlay) throw new Error('No play to call BS on.');
            if (lastPlay.gamePlayerId === callerGamePlayerId) throw new Error("Cannot call BS on your own play.");

            // Clear timers if in pending win
            if (gameState === 'pending_win') {
                GameStateManager.clearWinTimer(gameId);
                GameStateManager.clearPendingWin(gameId);
            }

            // Determine if it was a bluff
            const { gamePlayerId: challengedGamePlayerId, playerPosition: challengedPlayerPosition, cardsPlayed: actualCardsInLastPlay, declaredRank } = lastPlay;
            
            const rankMap: { [key: string]: number } = { 'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13 };
            const declaredNumericRank = rankMap[declaredRank.toUpperCase()];
            const wasBluff = actualCardsInLastPlay.some(card => card.value !== declaredNumericRank);

            // Get challenged player info
            const challengedPlayerRes = await client.query(
                `SELECT u.username FROM "user" u 
                 JOIN game_players gp ON u.user_id = gp.user_id 
                 WHERE gp.game_player_id = $1`,
                [challengedGamePlayerId]
            );
            const challengedUsername = challengedPlayerRes.rows[0]?.username || `P${challengedPlayerPosition + 1}`;
            const callerUsername = socket.username || `P${callerPosition + 1}`;

            const pile = GameStateManager.getGamePile(gameId);
            let pileReceiverGamePlayerId: number;
            let pileReceiverPosition: number;
            let eventMessage: string;

            if (wasBluff) {
                // Bluff was caught - challenged player gets pile
                pileReceiverGamePlayerId = challengedGamePlayerId;
                pileReceiverPosition = challengedPlayerPosition;
                eventMessage = `${callerUsername} correctly called BS! ${challengedUsername} was bluffing and takes the pile (${pile.length} cards).`;
            } else {
                // Incorrect BS call - caller gets pile
                pileReceiverGamePlayerId = callerGamePlayerId;
                pileReceiverPosition = callerPosition;
                eventMessage = `${callerUsername} called BS, but ${challengedUsername} was NOT bluffing! ${callerUsername} takes the pile (${pile.length} cards).`;
                
                // If incorrect BS call during pending win, challenged player wins immediately
                if (gameState === 'pending_win') {
                    await finalizePlayerWin(io, gameId, challengedGamePlayerId, challengedPlayerPosition, challengedUsername);
                    await client.query('COMMIT');
                    
                    io.to(`game:${gameId}`).emit('game:bsResult', {
                        callerPosition,
                        callerUsername,
                        challengedPlayerPosition,
                        challengedUsername,
                        wasBluff,
                        revealedCards: actualCardsInLastPlay,
                        pileReceiverPosition,
                        message: eventMessage + ` ${challengedUsername} wins the game!`
                    });
                    
                    callback?.({ success: true });
                    return;
                }
            }
            
            // Give pile to appropriate player
            if (pile.length > 0) {
                const insertPromises = pile.map(card => 
                    client.query(
                        'INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)',
                        [pileReceiverGamePlayerId, card.card_id]
                    )
                );
                await Promise.all(insertPromises);
            }
            
            // CRITICAL: Reset pile to 0 cards so dropdown appears for pile receiver
            GameStateManager.setGamePile(gameId, []);
            GameStateManager.clearLastPlay(gameId);
            
            // Set game to playing and give turn to pile receiver 
            // This is CORRECT - BS call gives turn to pile receiver, NOT continuing normal turn order
            await client.query(`UPDATE game SET state = 'playing' WHERE game_id = $1`, [gameIdInt]);
            await client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);
            await client.query(`UPDATE game_players SET is_turn = TRUE WHERE game_player_id = $1`, [pileReceiverGamePlayerId]);
            
            await client.query('COMMIT');
            
            console.log(`[GameTS:callBS] BS resolved: pile receiver ${pileReceiverPosition} gets turn, pile cleared (dropdown will appear)`);
            
            io.to(`game:${gameId}`).emit('game:bsResult', {
                callerPosition,
                callerUsername,
                challengedPlayerPosition,
                challengedUsername,
                wasBluff,
                revealedCards: actualCardsInLastPlay,
                pileReceiverPosition,
                message: eventMessage
            });
            
            await broadcastGameState(io, gameId);
            callback?.({ success: true });
            
        } catch (error: any) {
            await client.query('ROLLBACK');
            console.error(`[GameTS:callBS] Error for ${socket.username} in game ${gameId}:`, error);
            callback?.({ error: error.message || 'Failed to process BS call.' });
        } finally {
            client.release();
        }
    });
}
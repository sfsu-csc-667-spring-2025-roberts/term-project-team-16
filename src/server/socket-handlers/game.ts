import { Server as IOServer } from "socket.io";
import pool from "../config/database";
import { AugmentedSocket } from "../config/socket";

// Type interfaces
interface ChatMessage {
    content: string;
    username: string;
    created_at: Date;
    game_id: string | null;
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
    requiredRank?: string | null;
}

interface SocketWithRooms extends AugmentedSocket {
  currentGameRoom?: string;
  isInLobby?: boolean;
}

// =================== ROOM MANAGEMENT UTILITIES ===================

class RoomManager {
    static async joinLobby(socket: SocketWithRooms) {
        if (socket.currentGameRoom) {
            socket.leave(socket.currentGameRoom);
            console.log(`[RoomManager] Socket ${socket.id} left game room: ${socket.currentGameRoom}`);
        }
        
        socket.join('lobby');
        socket.isInLobby = true;
        socket.currentGameRoom = undefined;
        console.log(`[RoomManager] Socket ${socket.id} joined lobby`);
    }

    static async joinGameRoom(socket: SocketWithRooms, gameId: string) {
        const gameRoomName = `game:${gameId}`;
        
        if (socket.isInLobby) {
            socket.leave('lobby');
            socket.isInLobby = false;
        }
        
        if (socket.currentGameRoom && socket.currentGameRoom !== gameRoomName) {
            socket.leave(socket.currentGameRoom);
            console.log(`[RoomManager] Socket ${socket.id} left old game room: ${socket.currentGameRoom}`);
        }
        
        socket.join(gameRoomName);
        socket.currentGameRoom = gameRoomName;
        console.log(`[RoomManager] Socket ${socket.id} joined game room: ${gameRoomName}`);
    }

    static async cleanup(socket: SocketWithRooms) {
        if (socket.currentGameRoom) {
            socket.leave(socket.currentGameRoom);
        }
        if (socket.isInLobby) {
            socket.leave('lobby');
        }
        console.log(`[RoomManager] Cleaned up rooms for socket ${socket.id}`);
    }
}

// =================== DATABASE-PERSISTED GAME STATE MANAGER ===================

class GameStateManager {
    private static gameWinTimers = new Map<string, NodeJS.Timeout>();
    private static gamePendingWins = new Map<string, { playerPosition: number; playerUsername: string; startTime: number }>();
    
    private static getPilePlayerId(gameId: string): number {
        const gameIdInt = parseInt(gameId, 10);
        if (isNaN(gameIdInt) || gameIdInt <= 0) {
            throw new Error(`Invalid gameId for pile: ${gameId}`);
        }
        // Game 1 = pile -1, Game 2 = pile -2, etc.
        return -gameIdInt;
    }

    // =================== MULTI-GAME SAFE PILE MANAGEMENT ===================

    static async getGamePile(gameId: string): Promise<Card[]> {
        try {
            const pilePlayerId = this.getPilePlayerId(gameId);
            const result = await pool.query(
                `SELECT c.card_id, c.value, c.shape 
                 FROM cards_held ch
                 JOIN card c ON ch.card_id = c.card_id 
                 WHERE ch.game_player_id = $1 
                 ORDER BY ch.held_at, c.value, c.shape`,
                [pilePlayerId]
            );
            return result.rows;
        } catch (error) {
            console.error(`[GameStateManager:getGamePile] Error fetching pile for game ${gameId}:`, error);
            return [];
        }
    }

    static async addCardsToPile(gameId: string, cards: Card[], fromGamePlayerId: number): Promise<void> {
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const pilePlayerId = this.getPilePlayerId(gameId);
            
            for (const card of cards) {
                const deleteResult = await client.query(
                    'DELETE FROM cards_held WHERE game_player_id = $1 AND card_id = $2',
                    [fromGamePlayerId, card.card_id]
                );
                
                if (deleteResult.rowCount === 0) {
                    throw new Error(`Card ${card.card_id} not found in player ${fromGamePlayerId}'s hand`);
                }
                
                await client.query(
                    'INSERT INTO cards_held (game_player_id, card_id, held_at) VALUES ($1, $2, NOW())',
                    [pilePlayerId, card.card_id]
                );
            }
            
            await client.query('COMMIT');
            console.log(`[GameStateManager] Game ${gameId}: Moved ${cards.length} cards to pile (pile_id: ${pilePlayerId})`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`[GameStateManager:addCardsToPile] Error for game ${gameId}:`, error);
            throw error;
        } finally {
            client.release();
        }
    }

    static async transferPileToPlayer(gameId: string, toGamePlayerId: number): Promise<number> {
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const pilePlayerId = this.getPilePlayerId(gameId);
            
            const pileCards = await client.query(
                'SELECT card_id FROM cards_held WHERE game_player_id = $1',
                [pilePlayerId]
            );
            
            const cardCount = pileCards.rows.length;
            
            if (cardCount > 0) {
                await client.query(
                    'UPDATE cards_held SET game_player_id = $1, held_at = NOW() WHERE game_player_id = $2',
                    [toGamePlayerId, pilePlayerId]
                );
                console.log(`[GameStateManager] Game ${gameId}: Transferred ${cardCount} cards from pile to player ${toGamePlayerId}`);
            }
            
            await client.query('COMMIT');
            return cardCount;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`[GameStateManager:transferPileToPlayer] Error for game ${gameId}:`, error);
            throw error;
        } finally {
            client.release();
        }
    }

    static async clearGamePile(gameId: string): Promise<void> {
        try {
            const pilePlayerId = this.getPilePlayerId(gameId);
            const result = await pool.query('DELETE FROM cards_held WHERE game_player_id = $1', [pilePlayerId]);
            console.log(`[GameStateManager] Game ${gameId}: Cleared ${result.rowCount || 0} cards from pile (pile_id: ${pilePlayerId})`);
        } catch (error) {
            console.error(`[GameStateManager:clearGamePile] Error for game ${gameId}:`, error);
            throw error;
        }
    }

    static async getPileCardCount(gameId: string): Promise<number> {
        try {
            const pilePlayerId = this.getPilePlayerId(gameId);
            const result = await pool.query(
                'SELECT COUNT(*) as count FROM cards_held WHERE game_player_id = $1',
                [pilePlayerId]
            );
            return parseInt(result.rows[0].count, 10);
        } catch (error) {
            console.error(`[GameStateManager:getPileCardCount] Error for game ${gameId}:`, error);
            return 0;
        }
    }

    // =================== LAST PLAY TRACKING ===================

    static async getLastPlay(gameId: string): Promise<LastPlayInfo | null> {
        const gameIdInt = parseInt(gameId, 10);
        try {
            const result = await pool.query(
                `SELECT 
                    g.last_play_player_id as game_player_id,
                    gp.position as player_position,
                    g.last_play_declared_rank as declared_rank,
                    g.last_play_card_count as card_count,
                    g.last_play_timestamp as timestamp
                 FROM game g
                 LEFT JOIN game_players gp ON g.last_play_player_id = gp.game_player_id
                 WHERE g.game_id = $1 AND g.last_play_player_id IS NOT NULL`,
                [gameIdInt]
            );

            if (result.rows.length === 0) return null;

            const row = result.rows[0];
            const pileCards = await this.getGamePile(gameId);
            const lastPlayCardCount = row.card_count;
            const cardsPlayed = pileCards.slice(-lastPlayCardCount);

            return {
                gamePlayerId: row.game_player_id,
                playerPosition: row.player_position,
                cardsPlayed: cardsPlayed,
                declaredRank: row.declared_rank,
                cardCount: row.card_count,
                timestamp: row.timestamp
            };
        } catch (error) {
            console.error(`[GameStateManager:getLastPlay] Error fetching last play:`, error);
            return null;
        }
    }

    static async getLastPlayWithCards(gameId: string): Promise<LastPlayInfo | null> {
        const gameIdInt = parseInt(gameId, 10);
        try {
            const result = await pool.query(
                `SELECT 
                    g.last_play_player_id as game_player_id,
                    gp.position as player_position,
                    u.username as player_username,
                    g.last_play_declared_rank as declared_rank,
                    g.last_play_card_count as card_count,
                    g.last_play_timestamp as timestamp
                 FROM game g
                 LEFT JOIN game_players gp ON g.last_play_player_id = gp.game_player_id
                 LEFT JOIN "user" u ON gp.user_id = u.user_id
                 WHERE g.game_id = $1 AND g.last_play_player_id IS NOT NULL`,
                [gameIdInt]
            );

            if (result.rows.length === 0) return null;

            const row = result.rows[0];
            const pileCards = await this.getGamePile(gameId);
            const lastPlayCardCount = row.card_count;
            const cardsPlayed = pileCards.slice(-lastPlayCardCount);

            return {
                gamePlayerId: row.game_player_id,
                playerPosition: row.player_position,
                cardsPlayed: cardsPlayed,
                declaredRank: row.declared_rank,
                cardCount: row.card_count,
                timestamp: row.timestamp
            };
        } catch (error) {
            console.error(`[GameStateManager:getLastPlayWithCards] Error:`, error);
            return null;
        }
    }

    static async setLastPlay(gameId: string, play: LastPlayInfo): Promise<void> {
        const gameIdInt = parseInt(gameId, 10);
        try {
            await pool.query(
                `UPDATE game SET 
                    last_play_player_id = $1,
                    last_play_declared_rank = $2,
                    last_play_card_count = $3,
                    last_play_timestamp = $4
                 WHERE game_id = $5`,
                [play.gamePlayerId, play.declaredRank, play.cardCount, play.timestamp, gameIdInt]
            );
        } catch (error) {
            console.error(`[GameStateManager:setLastPlay] Error:`, error);
            throw error;
        }
    }

    static async clearLastPlay(gameId: string): Promise<void> {
        const gameIdInt = parseInt(gameId, 10);
        try {
            await pool.query(
                `UPDATE game SET 
                    last_play_player_id = NULL,
                    last_play_declared_rank = NULL,
                    last_play_card_count = NULL,
                    last_play_timestamp = NULL
                 WHERE game_id = $1`,
                [gameIdInt]
            );
        } catch (error) {
            console.error(`[GameStateManager:clearLastPlay] Error:`, error);
            throw error;
        }
    }

    // =================== TIMER & WIN MANAGEMENT ===================

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

    static async cleanupGame(gameId: string): Promise<void> {
        this.clearWinTimer(gameId);
        this.clearPendingWin(gameId);
        await this.clearLastPlay(gameId);
        await this.clearGamePile(gameId);
        console.log(`[GameStateManager] Cleaned up all state for game ${gameId}`);
    }
}

// =================== HELPER FUNCTIONS ===================

async function getNextRequiredRank(gameId: string): Promise<string | null> {
    const pileCardCount = await GameStateManager.getPileCardCount(gameId);
    
    if (pileCardCount === 0) {
        return null;
    }
    
    const lastPlay = await GameStateManager.getLastPlay(gameId);
    if (lastPlay) {
        return getNextRankInSequence(lastPlay.declaredRank);
    }
    
    return 'A';
}

function getNextRankInSequence(currentRank: string): string {
    const rankSequence = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const currentIndex = rankSequence.indexOf(currentRank);
    
    if (currentIndex === -1) {
        return 'A';
    }
    
    const nextIndex = (currentIndex + 1) % rankSequence.length;
    return rankSequence[nextIndex];
}

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

async function fetchFullGameStateForClient(gameId: string, targetUserId?: number): Promise<GameStateForClient | null> {
    const gameIdInt = parseInt(gameId, 10);
    if (isNaN(gameIdInt)) {
        console.error(`[GameTS:fetchFullGameState] Invalid gameId format: ${gameId}`);
        return null;
    }

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
        console.warn(`[GameTS:fetchFullGameState] Game not found: ${gameIdInt}`);
        return null;
    }

    const gameDbState = {
        state: gameAndPlayersResult.rows[0].state,
        current_num_players: gameAndPlayersResult.rows[0].current_num_players
    };

    const players: PlayerState[] = gameAndPlayersResult.rows
        .filter(row => row.user_id)
        .map(p => ({
            userId: p.user_id,
            username: p.username,
            position: p.position,
            card_count: parseInt(p.card_count, 10),
            isCurrentTurn: p.is_turn && !p.is_winner,
            isWinner: p.is_winner
        }));

    const currentTurnPosition = players.find(p => p.isCurrentTurn)?.position ?? -1;

    const pileCardCount = await GameStateManager.getPileCardCount(gameId);
    const lastPlay = await GameStateManager.getLastPlay(gameId);
    const requiredRank = await getNextRequiredRank(gameId);

    const gameState: GameStateForClient = {
        gameId,
        gameState: gameDbState,
        players,
        currentTurnPosition,
        lastPlay,
        pileCardCount,
        requiredRank
    };

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

    if (targetUserId) {
        const playerInfo = players.find(p => p.userId === targetUserId);
        if (playerInfo) {
            gameState.yourPosition = playerInfo.position;
            gameState.isMyTurn = playerInfo.isCurrentTurn;
            const gamePlayerRow = gameAndPlayersResult.rows.find(row => row.user_id === targetUserId);
            if (gamePlayerRow?.game_player_id) {
                gameState.hand = await getPlayerHand(gamePlayerRow.game_player_id);
            }
        }
    }

    return gameState;
}

async function broadcastGameState(io: IOServer, gameId: string) {
    try {
        const gameRoomName = `game:${gameId}`;
        
        const allPlayersState = await fetchFullGameStateForClient(gameId);
        if (!allPlayersState?.players) {
            console.error(`[GameTS:broadcastGameState] Failed to fetch game state for broadcast, gameId: ${gameId}`);
            return;
        }

        // Send general game state to entire room (no hands)
        const generalGameState = await fetchFullGameStateForClient(gameId);
        if (generalGameState) {
            delete generalGameState.hand;
            delete generalGameState.yourPosition;
            delete generalGameState.isMyTurn;
            
            io.to(gameRoomName).emit('game:stateUpdate', generalGameState);
        }

        // Send personalized data to each player
        for (const player of allPlayersState.players) {
            const specificGameState = await fetchFullGameStateForClient(gameId, player.userId);
            if (specificGameState) {
                const personalData = {
                    hand: specificGameState.hand,
                    yourPosition: specificGameState.yourPosition,
                    isMyTurn: specificGameState.isMyTurn
                };
                
                io.to(`user:${player.userId}`).emit('game:personalUpdate', personalData);
            }
        }

        console.log(`[GameTS:broadcastGameState] State broadcasted to game room: ${gameRoomName}`);
        
    } catch (error) {
        console.error(`[GameTS:broadcastGameState] Error broadcasting to game ${gameId}:`, error);
    }
}

async function advanceTurn(gameId: string): Promise<number> {
    const client = await pool.connect();
    const gameIdInt = parseInt(gameId, 10);
    
    try {
        await client.query('BEGIN');
        
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

        if (current_position !== -1) {
            await client.query(
                `UPDATE game_players SET is_turn = FALSE WHERE game_id = $1 AND position = $2`,
                [gameIdInt, current_position]
            );
        }

        let nextPosition = activePlayerPositions[0]; 
        if (current_position !== -1) {
            const currentIndex = activePlayerPositions.indexOf(current_position);
            if (currentIndex !== -1) {
                nextPosition = activePlayerPositions[(currentIndex + 1) % activePlayerPositions.length];
            } else {
                const higherPositions = activePlayerPositions.filter((pos: number) => pos > current_position);
                nextPosition = higherPositions.length > 0 ? higherPositions[0] : activePlayerPositions[0];
            }
        }

        const nextPlayerResult = await client.query(
            `UPDATE game_players SET is_turn = TRUE 
             WHERE game_id = $1 AND position = $2 AND is_winner = FALSE 
             RETURNING user_id, game_player_id`,
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

async function finalizePlayerWin(io: IOServer, gameId: string, winnerGamePlayerId: number, winnerPosition: number, winnerUsername: string) {
    const gameIdInt = parseInt(gameId, 10);
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        await Promise.all([
            client.query(`UPDATE game SET state = 'ended' WHERE game_id = $1`, [gameIdInt]),
            client.query(`UPDATE game_players SET is_winner = TRUE, is_turn = FALSE WHERE game_player_id = $1`, [winnerGamePlayerId]),
            client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1 AND game_player_id != $2`, [gameIdInt, winnerGamePlayerId])
        ]);
        
        await client.query('COMMIT');
        
        await GameStateManager.cleanupGame(gameId);
        
        const gameOverData = {
            winnerPosition,
            winnerUsername,
            message: `Player ${winnerUsername} (P${winnerPosition + 1}) has won the game!`
        };

        io.to(`game:${gameId}`).emit('game:gameOver', gameOverData);
        io.to('lobby').emit('game:ended', { gameId });
        
        console.log(`[GameTS:finalizePlayerWin] Game ${gameId} ended with winner: ${winnerUsername}`);
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[GameTS:finalizePlayerWin] Error finalizing win for game ${gameId}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

// =================== SOCKET HANDLERS ===================

export default function handleGameConnection(io: IOServer, socket: SocketWithRooms): void {
    console.log(`[GameTS] Socket ${socket.id} connected, user: ${socket.username || 'N/A'}`);
    
    RoomManager.joinLobby(socket);

    // =================== LOBBY HANDLERS ===================
    
    socket.on('lobby:join', async (callback) => {
        await RoomManager.joinLobby(socket);
        callback?.({ success: true });
    });

    socket.on('lobby:sendMessage', async ({ message }, callback) => {
        if (!socket.userId || !socket.username) {
            return callback?.({ error: 'Not authenticated.' });
        }

        const trimmedMessage = message.trim();
        if (!trimmedMessage || trimmedMessage.length > 500) {
            return callback?.({ error: 'Invalid message.' });
        }

        try {
            const result = await pool.query(
                `INSERT INTO messages (content, author, game_id, created_at) 
                 VALUES ($1, $2, NULL, NOW()) RETURNING created_at`,
                [trimmedMessage, socket.userId]
            );

            const messageData: ChatMessage = {
                content: trimmedMessage,
                username: socket.username,
                created_at: result.rows[0].created_at,
                game_id: null
            };

            io.to('lobby').emit('lobby:newMessage', messageData);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:lobby:sendMessage] Error:`, error);
            callback?.({ error: 'Failed to send message.' });
        }
    });

    socket.on('lobby:loadMessages', async (callback) => {
        try {
            const result = await pool.query(
                `SELECT m.content, u.username, m.created_at 
                 FROM messages m 
                 JOIN "user" u ON m.author = u.user_id 
                 WHERE m.game_id IS NULL 
                 ORDER BY m.created_at ASC LIMIT 50`
            );

            socket.emit('lobby:loadMessages', result.rows);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:lobby:loadMessages] Error:`, error);
            callback?.({ error: 'Failed to load messages.' });
        }
    });

    // =================== GAME ROOM HANDLERS ===================

    socket.on('game:join-room', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) { 
            return callback?.({ error: 'Not authenticated.' });
        }
        try {
            await RoomManager.joinGameRoom(socket, gameId);
            
            const gameState = await fetchFullGameStateForClient(gameId, socket.userId);
            if (!gameState) {
                await RoomManager.joinLobby(socket);
                return callback?.({ error: 'Game not found or failed to fetch state.' });
            }
            
            socket.emit('game:stateUpdate', gameState);
            await broadcastGameState(io, gameId); 
            callback?.({ success: true });
        } catch (error: any) {
            console.error(`[GameTS:join-room] Error:`, error.message);
            await RoomManager.joinLobby(socket);
            callback?.({ error: 'Server error joining room.' });
        }
    });

    socket.on('game:leave-room', async ({ gameId }, callback) => {
        await RoomManager.joinLobby(socket);
        console.log(`[GameTS:leave-room] Socket ${socket.id} returned to lobby from game ${gameId}`);
        callback?.({ success: true });
    });

    socket.on('game:sendMessage', async ({ gameId, message }, callback) => {
        if (!socket.userId || !socket.username) return callback?.({ error: 'Not authenticated.' });
        const trimmedMessage = message.trim();
        if (!trimmedMessage || trimmedMessage.length > 500) return callback?.({ error: 'Invalid message.' });
        try {
            const gameIdInt = parseInt(gameId, 10);
            
            const result = await pool.query(
                `INSERT INTO messages (content, author, game_id, created_at) 
                 VALUES ($1, $2, $3, NOW()) RETURNING created_at`,
                [trimmedMessage, socket.userId, gameIdInt]
            );

            const messageData: ChatMessage = { 
                content: trimmedMessage, 
                username: socket.username || 'Anonymous', 
                created_at: result.rows[0].created_at, 
                game_id: gameId 
            };

            io.to(`game:${gameId}`).emit('game:newMessage', messageData);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:sendMessage] Error:`, error);
            callback?.({ error: 'Failed to send message.' });
        }
    });

    socket.on('game:loadMessages', async ({ gameId }, callback) => {
        if (!socket.userId) return callback?.({ error: 'Not authenticated.' });
        try {
            const gameIdInt = parseInt(gameId, 10);
            
            const result = await pool.query(
                `SELECT m.content, u.username, m.created_at 
                 FROM messages m 
                 JOIN "user" u ON m.author = u.user_id 
                 WHERE m.game_id = $1 
                 ORDER BY m.created_at ASC LIMIT 50`,
                [gameIdInt]
            );

            socket.emit('game:loadMessages', result.rows);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:loadMessages] Error:`, error);
            callback?.({ error: 'Failed to load messages.' });
        }
    });

    socket.on('game:start', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) return callback?.({ error: 'Not authenticated.' });
        
        const gameIdInt = parseInt(gameId, 10);
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const playerCheck = await client.query(
                'SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2', 
                [gameIdInt, socket.userId]
            );
            if (playerCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return callback?.({ error: 'You are not a player in this game.' });
            }

            const gameRes = await client.query(
                'SELECT state, current_num_players FROM game WHERE game_id = $1 FOR UPDATE', 
                [gameIdInt]
            );
            if (!gameRes.rows.length) throw new Error('Game not found.');
            if (gameRes.rows[0].state !== 'waiting') throw new Error('Game already started or ended.');
            if (gameRes.rows[0].current_num_players < 2) throw new Error('Not enough players (min 2).');

            await client.query(`UPDATE game SET state = 'playing' WHERE game_id = $1`, [gameIdInt]);
            
            const playersInGameRes = await client.query(
                `SELECT gp.game_player_id, gp.user_id, gp.position 
                 FROM game_players gp WHERE gp.game_id = $1 ORDER BY gp.position`, 
                [gameIdInt]
            );
            const playersInGame = playersInGameRes.rows;
            if (playersInGame.length === 0) throw new Error("No players found for this game.");

            const cardsRes = await client.query('SELECT card_id, value, shape FROM card');
            let deck: Card[] = cardsRes.rows;
            deck = deck.sort(() => Math.random() - 0.5);

            const gamePlayerIds = playersInGame.map(p => p.game_player_id);
            
            console.log(`[GameStart] Clearing game state for game ${gameId}...`);
            
            await client.query(`DELETE FROM cards_held WHERE game_player_id = ANY($1::int[])`, [gamePlayerIds]);
            
            const pilePlayerId = -gameIdInt;
            await client.query('DELETE FROM cards_held WHERE game_player_id = $1', [pilePlayerId]);
            console.log(`[GameStart] Cleared pile for game ${gameId} (pile_id: ${pilePlayerId})`);
            
            await client.query(`UPDATE game SET 
                last_play_player_id = NULL,
                last_play_declared_rank = NULL,
                last_play_card_count = NULL,
                last_play_timestamp = NULL
                WHERE game_id = $1`, [gameIdInt]);
            
            await client.query(`UPDATE game_players SET is_winner = FALSE, is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);

            const cardsToDealTotal = Math.min(52, deck.length);
            for (let i = 0; i < cardsToDealTotal; i++) {
                const playerToReceive = playersInGame[i % playersInGame.length];
                const cardToDeal = deck.shift();
                if (cardToDeal) {
                    await client.query(
                        'INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)', 
                        [playerToReceive.game_player_id, cardToDeal.card_id]
                    );
                } else break;
            }

            const firstPlayer = playersInGame.find(p => p.position === 0) || playersInGame[0];
            await client.query(`UPDATE game_players SET is_turn = TRUE WHERE game_player_id = $1`, [firstPlayer.game_player_id]);
            
            await client.query('COMMIT');
            console.log(`[GameTS:start] Game ${gameId} started by ${socket.username} with isolated pile system.`);
            
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
            
            const playerGameResult = await client.query(
                `SELECT gp.game_player_id, gp.position, gp.is_turn, g.state as game_state
                 FROM game_players gp 
                 JOIN game g ON gp.game_id = g.game_id 
                 WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameIdInt, socket.userId]
            );

            if (!playerGameResult.rows.length) throw new Error('Player not found in this game.');
            
            const { game_player_id: gamePlayerId, position: playerPosition, is_turn: isTurn, game_state: gameState } = playerGameResult.rows[0];
            
            if (gameState !== 'playing') throw new Error('Game is not currently in playing state.');
            if (!isTurn) throw new Error("Not your turn.");

            const pileCardCount = await GameStateManager.getPileCardCount(gameId);
            let finalDeclaredRank: string;
            
            if (pileCardCount === 0) {
                if (!declaredRank || typeof declaredRank !== 'string') {
                    throw new Error('You must declare a rank when the pile is empty.');
                }
                finalDeclaredRank = declaredRank;
            } else {
                const requiredRank = await getNextRequiredRank(gameId);
                if (!requiredRank) throw new Error('Unable to determine required rank.');
                finalDeclaredRank = requiredRank;
            }

            const cardValidationPromises = cardsToPlayIds.map(async (cardIdStr: string) => {
                const cardId = parseInt(cardIdStr, 10);
                if (isNaN(cardId)) throw new Error(`Invalid card ID: ${cardIdStr}`);
                
                const cardRes = await client.query(
                    `SELECT c.card_id, c.value, c.shape
                     FROM cards_held ch
                     JOIN card c ON ch.card_id = c.card_id
                     WHERE ch.game_player_id = $1 AND ch.card_id = $2`,
                    [gamePlayerId, cardId]
                );
                
                if (cardRes.rowCount === 0) throw new Error(`Card ${cardId} not in your hand`);
                return cardRes.rows[0];
            });

            const playedCards = await Promise.all(cardValidationPromises);
            
            await GameStateManager.addCardsToPile(gameId, playedCards, gamePlayerId);
            
            const playInfo: LastPlayInfo = {
                gamePlayerId,
                playerPosition,
                cardsPlayed: playedCards,
                declaredRank: finalDeclaredRank,
                cardCount: cardsToPlayIds.length,
                timestamp: Date.now()
            };
            await GameStateManager.setLastPlay(gameId, playInfo);
            
            const remainingCardsCount = await client.query(
                `SELECT COUNT(*) as count FROM cards_held WHERE game_player_id = $1`,
                [gamePlayerId]
            );
            const cardsLeft = parseInt(remainingCardsCount.rows[0].count, 10);
            
            if (cardsLeft === 0) {
                await client.query(`UPDATE game SET state = 'pending_win' WHERE game_id = $1`, [gameIdInt]);
                await client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);
                
                const pendingWinInfo = {
                    playerPosition,
                    playerUsername: socket.username || `P${playerPosition + 1}`,
                    startTime: Date.now()
                };
                GameStateManager.setPendingWin(gameId, pendingWinInfo);
                
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
            console.error(`[GameTS:playCards] Error:`, error);
            callback?.({ error: error.message || 'Failed to play cards.' });
        } finally {
            client.release();
        }
    });

    socket.on('game:callBS', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) return callback?.({ error: 'Not authenticated.' });
        
        const gameIdInt = parseInt(gameId, 10);
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const currentTurnRes = await client.query(
                `SELECT game_player_id, position FROM game_players 
                 WHERE game_id = $1 AND is_turn = TRUE AND is_winner = FALSE`,
                [gameIdInt]
            );
            const currentTurnPlayer = currentTurnRes.rows.length > 0 ? currentTurnRes.rows[0] : null;
            
            const playerInfoRes = await client.query(
                `SELECT gp.game_player_id, gp.position, g.state as game_state 
                 FROM game_players gp JOIN game g ON gp.game_id = g.game_id 
                 WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameIdInt, socket.userId]
            );
            
            if (!playerInfoRes.rows.length) throw new Error('You are not a player in this game.');
            
            const { game_player_id: callerGamePlayerId, position: callerPosition, game_state: gameState } = playerInfoRes.rows[0];
            
            if (gameState !== 'playing' && gameState !== 'pending_win') {
                throw new Error('You can only call BS during an active game.');
            }

            const lastPlay = await GameStateManager.getLastPlayWithCards(gameId);
            if (!lastPlay) {
                throw new Error('No play to call BS on. Wait for someone to play cards first.');
            }
            
            if (lastPlay.gamePlayerId === callerGamePlayerId) {
                throw new Error("You cannot call BS on your own play!");
            }

            if (gameState === 'pending_win') {
                GameStateManager.clearWinTimer(gameId);
                GameStateManager.clearPendingWin(gameId);
            }

            const { gamePlayerId: challengedGamePlayerId, playerPosition: challengedPlayerPosition, cardsPlayed: actualCardsInLastPlay, declaredRank } = lastPlay;
            
            const rankMap: { [key: string]: number } = { 'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13 };
            const declaredNumericRank = rankMap[declaredRank.toUpperCase()];
            const wasBluff = actualCardsInLastPlay.some(card => card.value !== declaredNumericRank);

            const challengedPlayerRes = await client.query(
                `SELECT u.username FROM "user" u 
                 JOIN game_players gp ON u.user_id = gp.user_id 
                 WHERE gp.game_player_id = $1`,
                [challengedGamePlayerId]
            );
            const challengedUsername = challengedPlayerRes.rows[0]?.username || `P${challengedPlayerPosition + 1}`;
            const callerUsername = socket.username || `P${callerPosition + 1}`;

            let pileReceiverGamePlayerId: number;
            let pileReceiverPosition: number;
            let eventMessage: string;

            if (wasBluff) {
                pileReceiverGamePlayerId = challengedGamePlayerId;
                pileReceiverPosition = challengedPlayerPosition;
                eventMessage = `${callerUsername} correctly called BS! ${challengedUsername} was bluffing and takes the pile.`;
            } else {
                pileReceiverGamePlayerId = callerGamePlayerId;
                pileReceiverPosition = callerPosition;
                eventMessage = `${callerUsername} called BS, but ${challengedUsername} was NOT bluffing! ${callerUsername} takes the pile.`;
                
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
            
            const pileSize = await GameStateManager.transferPileToPlayer(gameId, pileReceiverGamePlayerId);

            await GameStateManager.clearLastPlay(gameId);
            await client.query(`UPDATE game SET state = 'playing' WHERE game_id = $1`, [gameIdInt]);

            if (currentTurnPlayer) {
                await client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);
                
                const restoreTurnRes = await client.query(
                    `UPDATE game_players SET is_turn = TRUE 
                     WHERE game_player_id = $1 AND is_winner = FALSE`,
                    [currentTurnPlayer.game_player_id]
                );
                
                if (restoreTurnRes.rowCount && restoreTurnRes.rowCount > 0) {
                    console.log(`[GameTS:callBS] Turn preserved for position ${currentTurnPlayer.position}`);
                } else {
                    await client.query(
                        `UPDATE game_players SET is_turn = TRUE 
                         WHERE game_id = $1 AND is_winner = FALSE 
                         AND game_player_id = (
                             SELECT game_player_id FROM game_players 
                             WHERE game_id = $1 AND is_winner = FALSE 
                             ORDER BY position LIMIT 1
                         )`,
                        [gameIdInt]
                    );
                }
            } else {
                await client.query(
                    `UPDATE game_players SET is_turn = TRUE 
                     WHERE game_id = $1 AND is_winner = FALSE 
                     AND game_player_id = (
                         SELECT game_player_id FROM game_players 
                         WHERE game_id = $1 AND is_winner = FALSE 
                         ORDER BY position LIMIT 1
                     )`,
                    [gameIdInt]
                );
            }

            await client.query('COMMIT');

            console.log(`[GameTS:callBS] BS resolved: ${pileSize} cards to position ${pileReceiverPosition}`);

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
            console.error(`[GameTS:callBS] Error:`, error);
            callback?.({ error: error.message || 'Failed to process BS call.' });
        } finally {
            client.release();
        }
    });

    socket.on('disconnect', async (reason) => {
        console.log(`[GameTS] Socket ${socket.id} disconnected: ${reason}`);
        await RoomManager.cleanup(socket);
    });
}
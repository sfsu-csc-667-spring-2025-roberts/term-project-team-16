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
        timeRemaining: number; // in seconds
    };
}

// Add game timers tracking
const gameWinTimers = new Map<string, NodeJS.Timeout>();
const gamePendingWins = new Map<string, { playerPosition: number; playerUsername: string; startTime: number }>();

const activeGamePiles = new Map<string, Card[]>();
const gameLastPlayInfo = new Map<string, LastPlayInfo>();

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

    const gameResult = await pool.query(
        'SELECT state, current_num_players FROM game WHERE game_id = $1',
        [gameIdInt]
    );
    if (gameResult.rows.length === 0) {
        console.warn(`[GameTS:fetchFullGameState] Game not found in DB: ${gameIdInt}`);
        return null;
    }
    const gameDbState = gameResult.rows[0];

    let currentTurnPosition = -1;
    if (gameDbState.state === 'playing' || gameDbState.state === 'pending_win') { 
        const turnResult = await pool.query(
            `SELECT position FROM game_players WHERE game_id = $1 AND is_turn = TRUE AND is_winner = FALSE`,
            [gameIdInt]
        );
        if (turnResult.rows.length > 0) {
            currentTurnPosition = turnResult.rows[0].position;
        }
    }

    const playersResult = await pool.query(
        `SELECT gp.user_id, u.username, gp.position, gp.is_turn, gp.game_player_id, gp.is_winner,
         (SELECT COUNT(*) FROM cards_held ch WHERE ch.game_player_id = gp.game_player_id) as card_count
         FROM game_players gp
         JOIN "user" u ON gp.user_id = u.user_id
         WHERE gp.game_id = $1
         ORDER BY gp.position`,
        [gameIdInt]
    );

    const players: PlayerState[] = playersResult.rows.map(p => ({
        userId: p.user_id,
        username: p.username,
        position: p.position,
        card_count: parseInt(p.card_count, 10),
        isCurrentTurn: p.is_turn && !p.is_winner, 
        isWinner: p.is_winner 
    }));

    const pile = activeGamePiles.get(gameId) || [];
    const lastPlay = gameLastPlayInfo.get(gameId) || null;

    const gameState: GameStateForClient = {
        gameId,
        gameState: gameDbState,
        players,
        currentTurnPosition,
        lastPlay,
        pileCardCount: pile.length,
    };

    // Add pending win info if game is in pending_win state
    if (gameDbState.state === 'pending_win') {
        const pendingWin = gamePendingWins.get(gameId);
        if (pendingWin) {
            const timeElapsed = (Date.now() - pendingWin.startTime) / 1000;
            const timeRemaining = Math.max(0, 15 - timeElapsed); // 15 second window
            gameState.pendingWin = {
                playerPosition: pendingWin.playerPosition,
                playerUsername: pendingWin.playerUsername,
                timeRemaining: Math.round(timeRemaining)
            };
        }
    }

    if (targetUserId) {
        const playerInfo = playersResult.rows.find(p => p.user_id === targetUserId);
        if (playerInfo) {
            gameState.yourPosition = playerInfo.position;
            if (playerInfo.game_player_id) {
                gameState.hand = await getPlayerHand(playerInfo.game_player_id);
            }
        }
    }

    return gameState;
}

async function broadcastGameState(io: IOServer, gameId: string) {
    const allPlayersState = await fetchFullGameStateForClient(gameId); 
    if (!allPlayersState || !allPlayersState.players) {
        console.error(`[GameTS:broadcastGameState] Failed to fetch all players state for broadcast, gameId: ${gameId}.`);
        return;
    }

    for (const player of allPlayersState.players) {
        const specificGameState = await fetchFullGameStateForClient(gameId, player.userId);
        if (specificGameState) {
            const targetSocketRoom = `user:${player.userId}`;
            io.to(targetSocketRoom).emit('game:stateUpdate', specificGameState);
        } else {
            console.error(`[GameTS:broadcastGameState] Failed to fetch specific game state for player ${player.userId} in game ${gameId}.`);
        }
    }
}

async function finalizePlayerWin(io: IOServer, gameId: string, winnerGamePlayerId: number, winnerPosition: number, winnerUsername: string) {
    const gameIdInt = parseInt(gameId, 10);
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        await client.query(`UPDATE game SET state = 'ended' WHERE game_id = $1`, [gameIdInt]);
        await client.query(`UPDATE game_players SET is_winner = TRUE, is_turn = FALSE WHERE game_player_id = $1`, [winnerGamePlayerId]);
        await client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1 AND game_player_id != $2`, [gameIdInt, winnerGamePlayerId]);
        
        await client.query('COMMIT');
        
        // Clean up timers and pending win data
        const timer = gameWinTimers.get(gameId);
        if (timer) {
            clearTimeout(timer);
            gameWinTimers.delete(gameId);
        }
        gamePendingWins.delete(gameId);
        
        io.to(`game:${gameId}`).emit('game:gameOver', { 
            winnerPosition, 
            winnerUsername, 
            message: `Player ${winnerUsername} (P${winnerPosition + 1}) has won the game!` 
        });
        
        // emit game over to the lobby
        io.emit('game:ended', { gameId });
        
        console.log(`[GameTS:finalizePlayerWin] Game ${gameId} ended with winner: ${winnerUsername} (P${winnerPosition + 1})`);
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[GameTS:finalizePlayerWin] Error finalizing win for game ${gameId}:`, error);
        throw error;
    } finally {
        client.release();
    }
}

async function advanceTurn(gameId: string): Promise<number> { 
    const client = await pool.connect();
    const gameIdInt = parseInt(gameId, 10);
    try {
        await client.query('BEGIN');
        const currentTurnPlayerResult = await client.query(
            `SELECT game_player_id, position FROM game_players WHERE game_id = $1 AND is_turn = TRUE AND is_winner = FALSE`,
            [gameIdInt]
        );

        let currentPosition = -1;
        if (currentTurnPlayerResult.rows.length > 0) {
            currentPosition = currentTurnPlayerResult.rows[0].position;
            await client.query(
                `UPDATE game_players SET is_turn = FALSE WHERE game_player_id = $1`,
                [currentTurnPlayerResult.rows[0].game_player_id]
            );
        }

        const activePlayersResult = await client.query(
            `SELECT position FROM game_players WHERE game_id = $1 AND is_winner = FALSE ORDER BY position ASC`,
            [gameIdInt]
        );
        const activePlayerPositions = activePlayersResult.rows.map(p => p.position);

        if (activePlayerPositions.length === 0) {
            await client.query('COMMIT'); 
            console.warn(`[GameTS:advanceTurn] No active (non-winning) players in game ${gameIdInt}. Game likely ended or in error state.`);
            return -1; 
        }
        
        let nextPlayerIndex = 0; 
        if (currentPosition !== -1) { 
            const currentPlayerIndexInActive = activePlayerPositions.indexOf(currentPosition);
            if (currentPlayerIndexInActive !== -1) { 
                nextPlayerIndex = (currentPlayerIndexInActive + 1) % activePlayerPositions.length;
            } else { 
                let foundNext = false;
                for(let i = 0; i < activePlayerPositions.length; i++) {
                    if (activePlayerPositions[i] > currentPosition) {
                        nextPlayerIndex = i;
                        foundNext = true;
                        break;
                    }
                }
                if (!foundNext && activePlayerPositions.length > 0) {
                    nextPlayerIndex = 0;
                } else if (!foundNext) {
                    await client.query('COMMIT');
                    console.error(`[GameTS:advanceTurn] Edge case: Could not determine next player after currentPosition ${currentPosition}. Active: ${activePlayerPositions.join(',')}`);
                    return -1;
                }
            }
        }
        
        const nextPosition = activePlayerPositions[nextPlayerIndex];
        
        const nextPlayerUpdateResult = await client.query(
            `UPDATE game_players SET is_turn = TRUE WHERE game_id = $1 AND position = $2 AND is_winner = FALSE RETURNING user_id`,
            [gameIdInt, nextPosition]
        );

        if(nextPlayerUpdateResult.rowCount === 0){
            console.error(`[GameTS:advanceTurn] Failed to set turn for next player at position ${nextPosition} in game ${gameIdInt}. They might have won, or no active player at that position.`);
            await client.query('COMMIT'); 
            return -1;
        }

        await client.query('COMMIT');
        console.log(`[GameTS:advanceTurn] Advanced turn to player position ${nextPosition} (User ID: ${nextPlayerUpdateResult.rows[0]?.user_id || 'N/A'}) in game ${gameIdInt}.`);
        return nextPosition;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[GameTS:advanceTurn] Error advancing turn in game ${gameIdInt}:`, error);
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
            activeGamePiles.set(gameId, []);
            gameLastPlayInfo.delete(gameId);

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
        if (!declaredRank || typeof declaredRank !== 'string' || declaredRank.trim() === '') return callback?.({ error: 'Declared rank required.' });
        
        const gameIdInt = parseInt(gameId, 10);
        const clientDb = await pool.connect();
        try {
            await clientDb.query('BEGIN');
            const playerInfoRes = await clientDb.query( 
                `SELECT gp.game_player_id, gp.position, gp.is_turn, g.state as game_state 
                 FROM game_players gp JOIN game g ON gp.game_id = g.game_id 
                 WHERE gp.game_id = $1 AND gp.user_id = $2`, 
                [gameIdInt, socket.userId]
            );
            if (!playerInfoRes.rows.length) throw new Error('Player not found in this game.');
            const { game_player_id: gamePlayerId, position: playerPosition, is_turn: isTurn, game_state: gameState } = playerInfoRes.rows[0];
            if (gameState !== 'playing') throw new Error('Game is not currently in playing state.');
            if (!isTurn) throw new Error("Not your turn.");

            const actualPlayedCardsDetails: Card[] = [];
            for (const cardIdStr of cardsToPlayIds) {
                const cardId = parseInt(cardIdStr, 10);
                if (isNaN(cardId)) throw new Error(`Invalid card ID format: ${cardIdStr}.`);
                const cardDetailsRes = await clientDb.query( 
                    `SELECT c.card_id, c.value, c.shape FROM card c 
                     JOIN cards_held ch ON c.card_id = ch.card_id 
                     WHERE ch.game_player_id = $1 AND ch.card_id = $2`, 
                    [gamePlayerId, cardId]
                );
                if(!cardDetailsRes.rows.length) throw new Error(`Card ID ${cardId} not found in your hand or invalid.`);
                actualPlayedCardsDetails.push(cardDetailsRes.rows[0]);
                const deleteResult = await clientDb.query('DELETE FROM cards_held WHERE game_player_id = $1 AND card_id = $2', [gamePlayerId, cardId]);
                if (deleteResult.rowCount === 0) throw new Error(`Failed to remove card ${cardId} from hand.`);
            }
            
            const pile = activeGamePiles.get(gameId) || [];
            pile.push(...actualPlayedCardsDetails);
            activeGamePiles.set(gameId, pile);
            const currentPlayInfo: LastPlayInfo = { gamePlayerId, playerPosition, cardsPlayed: actualPlayedCardsDetails, declaredRank, cardCount: cardsToPlayIds.length };
            gameLastPlayInfo.set(gameId, currentPlayInfo);
            
            const remainingCardsRes = await clientDb.query(`SELECT COUNT(*) as count FROM cards_held WHERE game_player_id = $1`, [gamePlayerId]);
            const remainingCardsCount = parseInt(remainingCardsRes.rows[0].count, 10);
            // game end checks
            if (remainingCardsCount === 0) {
                // Player played their last card - enter pending win state
                await clientDb.query(`UPDATE game SET state = 'pending_win' WHERE game_id = $1`, [gameIdInt]);
                await clientDb.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);
                
                // Store pending win info
                const pendingWinInfo = {
                    playerPosition,
                    playerUsername: socket.username || `P${playerPosition + 1}`,
                    startTime: Date.now()
                };
                gamePendingWins.set(gameId, pendingWinInfo);
                
                // Set timer to auto-resolve win after 15 seconds
                const winTimer = setTimeout(async () => {
                    try {
                        await finalizePlayerWin(io, gameId, gamePlayerId, playerPosition, socket.username || `P${playerPosition + 1}`);
                        await broadcastGameState(io, gameId);
                    } catch (error) {
                        console.error(`[GameTS:playCards] Error in win timer for game ${gameId}:`, error);
                    }
                }, 15000); // 15 second window
                
                gameWinTimers.set(gameId, winTimer);
                
                console.log(`[GameTS:playCards] Player ${socket.username || `P${playerPosition + 1}`} (P${playerPosition + 1}) played their last card. 15-second BS window started.`);
                
                io.to(`game:${gameId}`).emit('game:actionPlayed', { 
                    type: 'play', 
                    playerPosition, 
                    username: socket.username || `P${playerPosition + 1}`, 
                    cardCount: cardsToPlayIds.length, 
                    declaredRank 
                });
                
                io.to(`game:${gameId}`).emit('game:pendingWin', {
                    playerPosition,
                    playerUsername: socket.username || `P${playerPosition + 1}`,
                    timeWindow: 15,
                    message: `${socket.username || `P${playerPosition + 1}`} (P${playerPosition + 1}) played their last card! Call BS within 15 seconds or they win!`
                });
                
            } else {
                // Normal play - advance turn
                await advanceTurn(gameId);
                io.to(`game:${gameId}`).emit('game:actionPlayed', { 
                    type: 'play', 
                    playerPosition, 
                    username: socket.username || `P${playerPosition + 1}`, 
                    cardCount: cardsToPlayIds.length, 
                    declaredRank 
                });
            }
            
            await clientDb.query('COMMIT');
            await broadcastGameState(io, gameId);
            callback?.({ success: true });
        } catch (error: any) {
            try { await clientDb.query('ROLLBACK'); } catch (rbError) { console.error("[GameTS:playCards] Rollback error:", rbError); }
            console.error(`[GameTS:playCards] Error for ${socket.username || 'unknown user'} in game ${gameId}:`, error.message);
            callback?.({ error: error.message || 'Failed to play cards.' });
        } finally {
            clientDb.release();
        }
    });
    // call bs
    socket.on('game:callBS', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) return callback?.({ error: 'Not authenticated.' });
        const gameIdInt = parseInt(gameId, 10);
        const clientDb = await pool.connect();
        try {
            await clientDb.query('BEGIN');
            const playerInfoRes = await clientDb.query( 
                `SELECT gp.game_player_id, gp.position, g.state as game_state 
                 FROM game_players gp JOIN game g ON gp.game_id = g.game_id 
                 WHERE gp.game_id = $1 AND gp.user_id = $2`, 
                [gameIdInt, socket.userId]
            );
            if (!playerInfoRes.rows.length) throw new Error('Caller not found in this game.');
            const { game_player_id: callerGamePlayerId, position: callerPosition, game_state: gameState } = playerInfoRes.rows[0];
            
            // Allow BS calls during both playing and pending_win states
            if (gameState !== 'playing' && gameState !== 'pending_win') {
                throw new Error('Game is not in a state where BS can be called.');
            }

            const lastPlay = gameLastPlayInfo.get(gameId);
            if (!lastPlay) throw new Error('No play to call BS on.');
            if (lastPlay.gamePlayerId === callerGamePlayerId) throw new Error("Cannot call BS on your own play.");

            // If this is during pending_win, clear the win timer
            if (gameState === 'pending_win') {
                const timer = gameWinTimers.get(gameId);
                if (timer) {
                    clearTimeout(timer);
                    gameWinTimers.delete(gameId);
                }
                gamePendingWins.delete(gameId);
            }

            const { gamePlayerId: challengedGamePlayerId, playerPosition: challengedPlayerPosition, cardsPlayed: actualCardsInLastPlay, declaredRank } = lastPlay;
            let wasBluff = false;
            const rankMap: { [key: string]: number } = { 'A':1,'ACE':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'JACK':11,'Q':12,'QUEEN':12,'K':13,'KING':13 };
            const declaredNumericRank = rankMap[declaredRank.toUpperCase()];
            if (isNaN(declaredNumericRank)) throw new Error("Invalid declared rank in last play data.");
            for (const cardInPlay of actualCardsInLastPlay) { if (cardInPlay.value !== declaredNumericRank) { wasBluff = true; break; } }

            const pile = activeGamePiles.get(gameId) || [];
            let pileReceiverGamePlayerId: number, pileReceiverPosition: number, eventMessage: string;
            const challengedPlayerDbRes = await clientDb.query(`SELECT u.username FROM "user" u JOIN game_players gp ON u.user_id = gp.user_id WHERE gp.game_player_id = $1`, [challengedGamePlayerId]);
            const challengedUsername = challengedPlayerDbRes.rows.length ? challengedPlayerDbRes.rows[0].username : `P${challengedPlayerPosition+1}`;
            const callerUsername = socket.username || `P${callerPosition + 1}`;

            if (wasBluff) {
                pileReceiverGamePlayerId = challengedGamePlayerId; 
                pileReceiverPosition = challengedPlayerPosition;
                eventMessage = `${callerUsername} (P${callerPosition + 1}) correctly called BS! ${challengedUsername} (P${challengedPlayerPosition + 1}) was bluffing and takes the pile (${pile.length} cards).`;
                
                // If the challenged player was about to win but was bluffing, they get the pile and game continues
                if (gameState === 'pending_win') {
                    console.log(`[GameTS:callBS] Pending win cancelled - ${challengedUsername} was bluffing on their final play.`);
                }
            } else {
                pileReceiverGamePlayerId = callerGamePlayerId; 
                pileReceiverPosition = callerPosition;
                eventMessage = `${callerUsername} (P${callerPosition + 1}) called BS! ${challengedUsername} (P${challengedPlayerPosition + 1}) was NOT bluffing. ${callerUsername} takes the pile (${pile.length} cards).`;
                
                // If someone incorrectly called BS on a pending win, the challenged player wins immediately
                if (gameState === 'pending_win') {
                    console.log(`[GameTS:callBS] Incorrect BS call on pending win - ${challengedUsername} wins immediately.`);
                    await finalizePlayerWin(io, gameId, challengedGamePlayerId, challengedPlayerPosition, challengedUsername);
                    await clientDb.query('COMMIT');
                    
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
            
            // Game continues - give pile to appropriate player and set their turn
            if (pile.length > 0) { 
                for (const cardInPile of pile) {
                    await clientDb.query('INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)', [pileReceiverGamePlayerId, cardInPile.card_id]); 
                }
            }
            
            activeGamePiles.set(gameId, []);
            gameLastPlayInfo.delete(gameId);
            
            // Set game back to playing state and give turn to pile receiver
            await clientDb.query(`UPDATE game SET state = 'playing' WHERE game_id = $1`, [gameIdInt]);
            await clientDb.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);
            await clientDb.query(`UPDATE game_players SET is_turn = TRUE WHERE game_player_id = $1`, [pileReceiverGamePlayerId]);
            
            await clientDb.query('COMMIT');
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
            try { await clientDb.query('ROLLBACK'); } catch (rbError) { console.error("[GameTS:callBS] Rollback error:", rbError); }
            console.error(`[GameTS:callBS] Error for ${socket.username || 'unknown user'} in game ${gameId}:`, error);
            callback?.({ error: error.message || 'Failed to process BS call.' });
        } finally {
            clientDb.release();
        }
    });
}
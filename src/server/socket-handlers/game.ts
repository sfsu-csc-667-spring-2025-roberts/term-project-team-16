import { Server as IOServer } from "socket.io";
import pool from "../config/database";
import { AugmentedSocket } from "../config/socket";

// Interfaces (assuming these are correctly defined as before)
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
}

const activeGamePiles = new Map<string, Card[]>();
const gameLastPlayInfo = new Map<string, LastPlayInfo>();

// Helper functions (getPlayerGamePlayerId, getPlayerHand) - assumed correct from before

async function getPlayerGamePlayerId(gameId: string, userId: number): Promise<number | null> {
    // Ensure gameId is a number if your DB expects it, or cast appropriately
    const res = await pool.query(
        `SELECT game_player_id FROM game_players WHERE game_id = $1 AND user_id = $2`,
        [parseInt(gameId, 10), userId] // Assuming game_id in DB is integer
    );
    return res.rows.length > 0 ? res.rows[0].game_player_id : null;
}

async function getPlayerHand(gamePlayerId: number): Promise<Card[]> {
    const handRes = await pool.query(
        `SELECT c.card_id, c.value, c.shape 
         FROM cards_held ch 
         JOIN card c ON ch.card_id = c.card_id 
         WHERE ch.game_player_id = $1 
         ORDER BY c.value, c.shape`, // Ensure consistent hand order
        [gamePlayerId]
    );
    return handRes.rows;
}


async function fetchFullGameStateForClient(gameId: string, targetUserId?: number): Promise<GameStateForClient | null> {
    console.log(`[GameTS:fetchFullGameState] Fetching state for gameId: ${gameId}, targetUserId: ${targetUserId || 'N/A'}`);
    const gameIdInt = parseInt(gameId, 10); // Use consistent type for DB queries
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

    const turnResult = await pool.query(
        `SELECT position FROM game_players WHERE game_id = $1 AND is_turn = TRUE`,
        [gameIdInt]
    );
    const currentTurnPosition = turnResult.rows.length > 0 ? turnResult.rows[0].position : -1;
    if (currentTurnPosition === -1 && gameDbState.state === 'playing') {
        console.warn(`[GameTS:fetchFullGameState] Game ${gameIdInt} is 'playing' but no current turn found.`);
    }

    const playersResult = await pool.query(
        `SELECT gp.user_id, u.username, gp.position, gp.is_turn,
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
        isCurrentTurn: p.is_turn
    }));

    const pile = activeGamePiles.get(gameId) || [];
    const lastPlay = gameLastPlayInfo.get(gameId) || null;

    const gameState: GameStateForClient = {
        gameId, // Keep original string gameId for client consistency
        gameState: gameDbState,
        players,
        currentTurnPosition,
        lastPlay,
        pileCardCount: pile.length,
    };

    if (targetUserId) {
        const player = players.find(p => p.userId === targetUserId);
        if (player) {
            gameState.yourPosition = player.position;
            const gamePlayerId = await getPlayerGamePlayerId(gameId, targetUserId); // gameId as string
            if (gamePlayerId) {
                gameState.hand = await getPlayerHand(gamePlayerId);
                console.log(`[GameTS:fetchFullGameState] Fetched hand for userId ${targetUserId} in game ${gameId}: ${gameState.hand?.length} cards`);
            } else {
                 console.warn(`[GameTS:fetchFullGameState] Could not find game_player_id for userId ${targetUserId} in game ${gameId}`);
            }
        } else {
            console.warn(`[GameTS:fetchFullGameState] targetUserId ${targetUserId} not found in players list for game ${gameId}`);
        }
    }
    console.log(`[GameTS:fetchFullGameState] Constructed state for game ${gameId}, target ${targetUserId || 'all'}:`, {
        yourPosition: gameState.yourPosition,
        handCount: gameState.hand?.length,
        currentTurn: gameState.currentTurnPosition,
        lastPlay: !!gameState.lastPlay
    });
    return gameState;
}

async function broadcastGameState(io: IOServer, gameId: string) {
    console.log(`[GameTS:broadcastGameState] Broadcasting game state for gameId: ${gameId}`);
    const baseGameStateForLog = await fetchFullGameStateForClient(gameId); // For general player list
    if (!baseGameStateForLog || !baseGameStateForLog.players) {
        console.error(`[GameTS:broadcastGameState] Failed to fetch base game state or players for broadcast, gameId: ${gameId}.`);
        return;
    }

    for (const player of baseGameStateForLog.players) {
        // Fetch state specifically for this player (to include their hand)
        const specificGameState = await fetchFullGameStateForClient(gameId, player.userId);
        if (specificGameState) {
            const targetSocketRoom = `user:${player.userId}`;
            console.log(`[GameTS:broadcastGameState] Emitting 'game:stateUpdate' to ${targetSocketRoom} for game ${gameId}`);
            io.to(targetSocketRoom).emit('game:stateUpdate', specificGameState);
        } else {
            console.error(`[GameTS:broadcastGameState] Failed to fetch specific game state for player ${player.userId} in game ${gameId}.`);
        }
    }
}

async function advanceTurn(gameId: string): Promise<number> {
    const client = await pool.connect();
    const gameIdInt = parseInt(gameId, 10);
    try {
        await client.query('BEGIN');
        const currentTurnPlayerResult = await client.query(
            `SELECT game_player_id, position FROM game_players WHERE game_id = $1 AND is_turn = TRUE`,
            [gameIdInt]
        );

        let currentPosition = -1;
        if (currentTurnPlayerResult.rows.length > 0) {
            currentPosition = currentTurnPlayerResult.rows[0].position;
            await client.query(
                `UPDATE game_players SET is_turn = FALSE WHERE game_player_id = $1`,
                [currentTurnPlayerResult.rows[0].game_player_id]
            );
        } else {
            console.warn(`[GameTS:advanceTurn] No current turn player found for game ${gameIdInt}, defaulting to position -1 to calculate next.`);
        }

        const playerCountResult = await client.query(
            `SELECT COUNT(*) as count FROM game_players WHERE game_id = $1`,
            [gameIdInt]
        );
        const playerCount = parseInt(playerCountResult.rows[0].count, 10);

        if (playerCount === 0) {
            await client.query('ROLLBACK');
            console.error(`[GameTS:advanceTurn] No players in game ${gameIdInt}, cannot advance turn.`);
            throw new Error("No players in game, cannot advance turn.");
        }

        const nextPosition = (currentPosition + 1) % playerCount;
        const nextPlayerResult = await client.query(
            `UPDATE game_players SET is_turn = TRUE WHERE game_id = $1 AND position = $2 RETURNING user_id`,
            [gameIdInt, nextPosition]
        );
        await client.query('COMMIT');
        console.log(`[GameTS:advanceTurn] Advanced turn to player position ${nextPosition} (User ID: ${nextPlayerResult.rows[0]?.user_id || 'N/A'}) in game ${gameIdInt}.`);
        return nextPosition;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[GameTS:advanceTurn] Error advancing turn in game ${gameIdInt}:`, error);
        throw error; // Re-throw to be caught by the caller
    } finally {
        client.release();
    }
}


export default function handleGameConnection(io: IOServer, socket: AugmentedSocket): void {
    console.log(`[GameTS:handleGameConnection] Socket connected: socketId=${socket.id}, userId=${socket.userId || 'N/A'}`);

    // It's crucial that socket.userId and socket.username are populated by the middleware in socket.ts
    // if actions within this handler require authentication.

    socket.on('game:join-room', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) {
            console.warn(`[GameTS:join-room] Unauthorized attempt to join room for game ${gameId} by socket ${socket.id}. Missing userId/username.`);
            return callback?.({ error: 'Not authenticated. Please log in to join a game room.' });
        }
        try {
            socket.join(`game:${gameId}`); // For game-wide broadcasts
            // User-specific room is already joined in configureSockets if authenticated
            console.log(`[GameTS:join-room] User ${socket.username} (socket ${socket.id}, userId ${socket.userId}) joined room game:${gameId}.`);
            
            // Send initial full game state to the joining user
            const gameState = await fetchFullGameStateForClient(gameId, socket.userId);
            if (!gameState) {
                console.error(`[GameTS:join-room] Game ${gameId} not found when user ${socket.username} tried to join.`);
                return callback?.({ error: 'Game not found or failed to fetch state.' });
            }
            socket.emit('game:stateUpdate', gameState);
            
            // Announce to others or update their view if necessary (broadcastGameState does this more comprehensively)
            // Consider if a simple "player joined" message is needed or if broadcastGameState is sufficient
            await broadcastGameState(io, gameId); // This will update everyone, including the new player again (which is fine)

            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:join-room] Error for user ${socket.username} joining game ${gameId}:`, error);
            callback?.({ error: 'Server error: Failed to join game room.' });
        }
    });

    socket.on('game:leave-room', ({ gameId }, callback) => {
        // User-specific room `user:${userId}` is left on disconnect.
        // Leaving `game:${gameId}` room.
        socket.leave(`game:${gameId}`);
        console.log(`[GameTS:leave-room] Socket ${socket.id} (userId ${socket.userId || 'N/A'}) left room game:${gameId}.`);
        // Potentially notify other players or update game state if a player actively leaves mid-game.
        // For now, this is mostly for client-side cleanup on page unload.
        callback?.({ success: true });
    });

    socket.on('game:sendMessage', async ({ gameId, message }, callback) => {
        if (!socket.userId || !socket.username) {
            return callback?.({ error: 'Not authenticated to send messages.' });
        }
        const trimmedMessage = message.trim();
        if (!trimmedMessage || trimmedMessage.length === 0 || trimmedMessage.length > 500) {
            return callback?.({ error: 'Invalid message: Empty or too long.' });
        }
        try {
            const gameIdInt = parseInt(gameId, 10);
            const result = await pool.query(
                `INSERT INTO messages (content, author, game_id, created_at)
                 VALUES ($1, $2, $3, NOW()) RETURNING created_at`,
                [trimmedMessage, socket.userId, gameIdInt]
            );
            const messageData: ChatMessage = {
                content: trimmedMessage,
                username: socket.username,
                created_at: result.rows[0].created_at,
                game_id: gameId
            };
            io.to(`game:${gameId}`).emit('game:newMessage', messageData);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:sendMessage] Error for user ${socket.username} in game ${gameId}:`, error);
            callback?.({ error: 'Failed to send message due to server error.' });
        }
    });

    socket.on('game:loadMessages', async ({ gameId }, callback) => {
        if (!socket.userId) { // Basic auth check, though viewing messages might be public
             console.warn(`[GameTS:loadMessages] Unauthorized attempt to load messages for game ${gameId} by socket ${socket.id}.`);
            return callback?.({ error: 'Not authenticated to load messages.' });
        }
        try {
            const gameIdInt = parseInt(gameId, 10);
            const result = await pool.query(
                `SELECT m.content, u.username, m.created_at
                 FROM messages m JOIN "user" u ON m.author = u.user_id
                 WHERE m.game_id = $1 ORDER BY m.created_at ASC LIMIT 50`, // ASC for chronological, reverse on client if needed
                [gameIdInt]
            );
            socket.emit('game:loadMessages', result.rows); // Client will handle reversing if they want latest at bottom
            callback?.({ success: true });
        } catch (error) {
            console.error(`[GameTS:loadMessages] Error loading messages for game ${gameId}:`, error);
            callback?.({ error: 'Failed to load message history.' });
        }
    });

    socket.on('game:start', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) {
            return callback?.({ error: 'Not authenticated to start game.' });
        }
        const gameIdInt = parseInt(gameId, 10);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Ensure the user starting the game is part of it (optional, but good practice)
            const playerCheck = await client.query(
                'SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2',
                [gameIdInt, socket.userId]
            );
            if (playerCheck.rows.length === 0) {
                 await client.query('ROLLBACK');
                return callback?.({ error: 'You are not a player in this game.' });
            }

            const gameRes = await client.query('SELECT state, current_num_players FROM game WHERE game_id = $1 FOR UPDATE', [gameIdInt]);
            if (!gameRes.rows.length) throw new Error('Game not found.');
            if (gameRes.rows[0].state !== 'waiting') throw new Error('Game already started or ended.');
            if (gameRes.rows[0].current_num_players < 2) throw new Error('Not enough players (min 2).');

            await client.query(`UPDATE game SET state = 'playing' WHERE game_id = $1`, [gameIdInt]);
            
            const playersRes = await client.query(
                `SELECT gp.game_player_id, gp.user_id, gp.position 
                 FROM game_players gp WHERE gp.game_id = $1 ORDER BY gp.position`,
                [gameIdInt]
            );
            const playersInGame = playersRes.rows; // Renamed to avoid conflict with outer scope 'players'
            if (playersInGame.length === 0) throw new Error("No players found in game_players for this game.");

            const cardsRes = await client.query('SELECT card_id, value, shape FROM card');
            let deck: Card[] = cardsRes.rows;
            deck = deck.sort(() => Math.random() - 0.5); // Shuffle deck

            // Clear existing cards for these players in this game (if any, e.g. from a previous unfinished game)
            const gamePlayerIds = playersInGame.map(p => p.game_player_id);
            await client.query(`DELETE FROM cards_held WHERE game_player_id = ANY($1::int[])`, [gamePlayerIds]);

            const cardsToDealTotal = Math.min(52, deck.length); // Deal up to 52 cards or full deck
            let cardsDealtCount = 0;
            for (let i = 0; i < cardsToDealTotal; i++) {
                const playerToReceive = playersInGame[i % playersInGame.length];
                const cardToDeal = deck.shift();
                if (cardToDeal) {
                     await client.query(
                        'INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)',
                        [playerToReceive.game_player_id, cardToDeal.card_id]
                    );
                    cardsDealtCount++;
                } else {
                    console.warn(`[GameTS:start] Deck ran out of cards prematurely while dealing for game ${gameIdInt}`);
                    break; 
                }
            }
            console.log(`[GameTS:start] Dealt ${cardsDealtCount} cards for game ${gameIdInt}.`);
            
            activeGamePiles.set(gameId, []); // Clear pile for this game (using string gameId for map key)
            gameLastPlayInfo.delete(gameId);  // Clear last play info

            // Set turn for the first player (position 0)
            await client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);
            await client.query(`UPDATE game_players SET is_turn = TRUE WHERE game_id = $1 AND position = 0`, [gameIdInt]);

            await client.query('COMMIT');
            console.log(`[GameTS:start] Game ${gameId} started successfully by ${socket.username}.`);
            await broadcastGameState(io, gameId); // gameId as string
            callback?.({ success: true });
        } catch (error: any) {
            await client.query('ROLLBACK');
            console.error(`[GameTS:start] Error starting game ${gameId} by ${socket.username}:`, error);
            callback?.({ error: error.message || 'Failed to start game due to server error.' });
        } finally {
            client.release();
        }
    });

    // game:playCards and game:callBS handlers need similar robust checks for socket.userId
    // and careful error handling, ensuring broadcastGameState is called on success.
    // (Assuming the logic within them is mostly sound as per previous analysis, focusing on auth and top-level flow here)

    socket.on('game:playCards', async ({ gameId, cardsToPlayIds, declaredRank }, callback) => {
        if (!socket.userId || !socket.username) {
            return callback?.({ error: 'Not authenticated to play cards.' });
        }
        if (!Array.isArray(cardsToPlayIds) || cardsToPlayIds.length === 0) {
            return callback?.({ error: 'No cards selected to play.' });
        }
        if (!declaredRank || typeof declaredRank !== 'string' || declaredRank.trim() === '') {
            return callback?.({ error: 'Declared rank is required and must be valid.' });
        }

        const gameIdInt = parseInt(gameId, 10);
        const clientDb = await pool.connect();
        try {
            await clientDb.query('BEGIN');
            const playerInfoRes = await clientDb.query(
                `SELECT gp.game_player_id, gp.position, gp.is_turn 
                 FROM game_players gp WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameIdInt, socket.userId]
            );
            if (!playerInfoRes.rows.length) throw new Error('Player not found in this game.');
            const { game_player_id: gamePlayerId, position: playerPosition, is_turn: isTurn } = playerInfoRes.rows[0];

            if (!isTurn) throw new Error("Not your turn.");

            const actualPlayedCardsDetails: Card[] = [];
            for (const cardId of cardsToPlayIds) {
                const cardIdInt = parseInt(cardId, 10); // Assuming cardId from client might be string
                if (isNaN(cardIdInt)) throw new Error(`Invalid card ID format: ${cardId}`);

                // Verify card is in hand and remove it
                const cardDetailsRes = await clientDb.query(
                    `SELECT c.card_id, c.value, c.shape 
                     FROM card c JOIN cards_held ch ON c.card_id = ch.card_id
                     WHERE ch.game_player_id = $1 AND ch.card_id = $2`,
                    [gamePlayerId, cardIdInt]
                );
                if(!cardDetailsRes.rows.length) throw new Error(`Card ID ${cardIdInt} not found in your hand or invalid.`);
                actualPlayedCardsDetails.push(cardDetailsRes.rows[0]);

                const deleteResult = await clientDb.query(
                    'DELETE FROM cards_held WHERE game_player_id = $1 AND card_id = $2',
                    [gamePlayerId, cardIdInt]
                );
                if (deleteResult.rowCount === 0) throw new Error(`Failed to remove card ${cardIdInt} from hand. It might have already been played or was not in hand.`);
            }
            
            const pile = activeGamePiles.get(gameId) || []; // Use string gameId for map
            pile.push(...actualPlayedCardsDetails);
            activeGamePiles.set(gameId, pile);

            const currentPlayInfo: LastPlayInfo = {
                gamePlayerId: gamePlayerId,
                playerPosition: playerPosition,
                cardsPlayed: actualPlayedCardsDetails,
                declaredRank: declaredRank,
                cardCount: cardsToPlayIds.length
            };
            gameLastPlayInfo.set(gameId, currentPlayInfo); // Use string gameId for map
            
            const remainingCardsRes = await clientDb.query(
                `SELECT COUNT(*) as count FROM cards_held WHERE game_player_id = $1`,
                [gamePlayerId]
            );
            const remainingCardsCount = parseInt(remainingCardsRes.rows[0].count, 10);

            if (remainingCardsCount === 0) {
                // Player has won
                await clientDb.query(`UPDATE game SET state = 'ended' WHERE game_id = $1`, [gameIdInt]);
                await clientDb.query(`UPDATE game_players SET is_winner = TRUE, is_turn = FALSE WHERE game_player_id = $1`, [gamePlayerId]);
                // Ensure no one else is marked as turn
                await clientDb.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1 AND game_player_id != $2`, [gameIdInt, gamePlayerId]);

                console.log(`[GameTS:playCards] Player ${socket.username} (Pos: ${playerPosition}) has won game ${gameId}!`);
                io.to(`game:${gameId}`).emit('game:gameOver', { // Use string gameId for room
                    winnerPosition: playerPosition,
                    winnerUsername: socket.username,
                    message: `Player ${socket.username} (P${playerPosition + 1}) has played all their cards and won!`
                });
            } else {
                 await advanceTurn(gameId); // Pass string gameId
            }

            await clientDb.query('COMMIT');
            io.to(`game:${gameId}`).emit('game:actionPlayed', { // Use string gameId for room
                 type: 'play',
                 playerPosition: playerPosition,
                 username: socket.username,
                 cardCount: cardsToPlayIds.length,
                 declaredRank: declaredRank,
            });
            await broadcastGameState(io, gameId); // Pass string gameId
            callback?.({ success: true });
        } catch (error: any) {
            await clientDb.query('ROLLBACK');
            console.error(`[GameTS:playCards] Error for ${socket.username} in game ${gameId}:`, error);
            callback?.({ error: error.message || 'Failed to play cards due to server error.' });
        } finally {
            clientDb.release();
        }
    });


    socket.on('game:callBS', async ({ gameId }, callback) => {
        if (!socket.userId || !socket.username) {
            return callback?.({ error: 'Not authenticated to call BS.' });
        }

        const gameIdInt = parseInt(gameId, 10);
        const clientDb = await pool.connect();
        try {
            await clientDb.query('BEGIN');
            const callerInfoRes = await clientDb.query(
                `SELECT gp.game_player_id, gp.position, gp.is_turn 
                 FROM game_players gp WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameIdInt, socket.userId]
            );
            if (!callerInfoRes.rows.length) throw new Error('Caller not found in this game.');
            const { game_player_id: callerGamePlayerId, position: callerPosition, is_turn: isCallersTurn } = callerInfoRes.rows[0];

            if (!isCallersTurn) throw new Error("Not your turn to call BS.");

            const lastPlay = gameLastPlayInfo.get(gameId); // Use string gameId for map
            if (!lastPlay) throw new Error('No play to call BS on. The pile might be clean.');
            if (lastPlay.gamePlayerId === callerGamePlayerId) throw new Error("Cannot call BS on your own play.");

            const {
                gamePlayerId: challengedGamePlayerId,
                playerPosition: challengedPlayerPosition,
                cardsPlayed: actualCardsInLastPlay,
                declaredRank,
            } = lastPlay;

            let wasBluff = false;
            // Rank mapping should be robust, handle various inputs if necessary (e.g. 'ace', 'ACE', 'A')
            const rankMap: { [key: string]: number } = { 'A':1, 'ACE':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'JACK':11, 'Q':12, 'QUEEN':12, 'K':13, 'KING':13 };
            const declaredNumericRank = rankMap[declaredRank.toUpperCase()];

            if (isNaN(declaredNumericRank)) {
                console.error(`[GameTS:callBS] Invalid declared rank in last play data: ${declaredRank}`);
                throw new Error("Invalid declared rank in the last play data. Cannot resolve BS call.");
            }

            for (const cardInPlay of actualCardsInLastPlay) {
                if (cardInPlay.value !== declaredNumericRank) {
                    wasBluff = true;
                    break;
                }
            }

            const pile = activeGamePiles.get(gameId) || []; // Use string gameId for map
            let pileReceiverGamePlayerId: number;
            let pileReceiverPosition: number;
            let eventMessage: string;

            const challengedPlayerDbRes = await clientDb.query(
                `SELECT u.username FROM "user" u JOIN game_players gp ON u.user_id = gp.user_id WHERE gp.game_player_id = $1`,
                [challengedGamePlayerId]
            );
            const challengedUsername = challengedPlayerDbRes.rows.length ? challengedPlayerDbRes.rows[0].username : `Player at Pos ${challengedPlayerPosition+1}`;
            const callerUsername = socket.username; // Already known

            if (wasBluff) {
                pileReceiverGamePlayerId = challengedGamePlayerId;
                pileReceiverPosition = challengedPlayerPosition;
                eventMessage = `${callerUsername} (P${callerPosition + 1}) correctly called BS! ${challengedUsername} (P${challengedPlayerPosition + 1}) WAS bluffing and takes the pile.`;
            } else {
                pileReceiverGamePlayerId = callerGamePlayerId;
                pileReceiverPosition = callerPosition;
                eventMessage = `${callerUsername} (P${callerPosition + 1}) called BS! ${challengedUsername} (P${challengedPlayerPosition + 1}) was NOT bluffing. ${callerUsername} takes the pile.`;
            }

            if (pile.length > 0) {
                for (const cardInPile of pile) {
                    await clientDb.query(
                        'INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)',
                        [pileReceiverGamePlayerId, cardInPile.card_id]
                    );
                }
                console.log(`[GameTS:callBS] Player ${pileReceiverPosition === callerPosition ? callerUsername : challengedUsername} took ${pile.length} cards from the pile for game ${gameId}.`);
            }
            
            activeGamePiles.set(gameId, []); // Clear the pile (use string gameId for map)
            gameLastPlayInfo.delete(gameId); // Clear the last play info (use string gameId for map)

            // Set turn to the player who took the pile
            await clientDb.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameIdInt]);
            await clientDb.query(`UPDATE game_players SET is_turn = TRUE WHERE game_player_id = $1`, [pileReceiverGamePlayerId]);
            
            await clientDb.query('COMMIT');
            io.to(`game:${gameId}`).emit('game:bsResult', { // Use string gameId for room
                callerPosition,
                callerUsername,
                challengedPlayerPosition,
                challengedUsername,
                wasBluff,
                revealedCards: actualCardsInLastPlay, // Send the actual cards from the play being challenged
                pileReceiverPosition,
                message: eventMessage
            });
            await broadcastGameState(io, gameId); // Pass string gameId
            callback?.({ success: true });
        } catch (error: any) {
            await clientDb.query('ROLLBACK');
            console.error(`[GameTS:callBS] Error for ${socket.username} in game ${gameId}:`, error);
            callback?.({ error: error.message || 'Failed to process BS call due to server error.' });
        } finally {
            clientDb.release();
        }
    });

    // Disconnect logic is handled by the main 'disconnect' in socket.ts
}

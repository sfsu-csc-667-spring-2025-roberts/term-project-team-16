import { Server as IOServer, Socket as OriginalSocket } from "socket.io"; // Use OriginalSocket to avoid name clash
import pool from "../config/database";
import { AugmentedSocket } from "../config/socket"; // Import AugmentedSocket

// Define an interface for the socket object that includes your custom properties
// Moved to socket.ts to be reusable, re-export or define locally if preferred
// interface AugmentedSocket extends OriginalSocket {
//     userId?: number;
//     username?: string;
// }

interface ChatMessage {
    content: string;
    username: string;
    created_at: Date;
    game_id: string;
}

interface Card {
    card_id: number;
    value: number; // 1 (Ace) to 13 (King)
    shape: string; // 'hearts', 'diamonds', 'clubs', 'spades'
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


async function getPlayerGamePlayerId(gameId: string, userId: number): Promise<number | null> {
    const res = await pool.query(
        `SELECT game_player_id FROM game_players WHERE game_id = $1 AND user_id = $2`,
        [gameId, userId]
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
    const gameResult = await pool.query(
        'SELECT state, current_num_players FROM game WHERE game_id = $1',
        [gameId]
    );
    if (gameResult.rows.length === 0) return null;
    const gameDbState = gameResult.rows[0];

    const turnResult = await pool.query(
        `SELECT position FROM game_players WHERE game_id = $1 AND is_turn = TRUE`,
        [gameId]
    );
    const currentTurnPosition = turnResult.rows.length > 0 ? turnResult.rows[0].position : -1;

    const playersResult = await pool.query(
        `SELECT gp.user_id, u.username, gp.position, gp.is_turn,
         (SELECT COUNT(*) FROM cards_held ch WHERE ch.game_player_id = gp.game_player_id) as card_count
         FROM game_players gp
         JOIN "user" u ON gp.user_id = u.user_id
         WHERE gp.game_id = $1
         ORDER BY gp.position`,
        [gameId]
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
        gameId,
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
            const gamePlayerId = await getPlayerGamePlayerId(gameId, targetUserId);
            if (gamePlayerId) {
                gameState.hand = await getPlayerHand(gamePlayerId);
            }
        }
    }
    return gameState;
}

async function broadcastGameState(io: IOServer, gameId: string) { // Correctly type io
    console.log(`[game:${gameId}] Broadcasting game state update.`);
    const baseGameState = await fetchFullGameStateForClient(gameId);
    if (!baseGameState) {
        console.error(`[game:${gameId}] Failed to fetch base game state for broadcast.`);
        return;
    }

    for (const player of baseGameState.players) {
        const specificGameState = await fetchFullGameStateForClient(gameId, player.userId);
        if (specificGameState) {
            io.to(`user:${player.userId}`).emit('game:stateUpdate', specificGameState);
        }
    }
}

async function advanceTurn(gameId: string): Promise<number> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const currentTurnPlayerResult = await client.query(
            `SELECT game_player_id, position FROM game_players WHERE game_id = $1 AND is_turn = TRUE`,
            [gameId]
        );

        let currentPosition = -1;
        if (currentTurnPlayerResult.rows.length > 0) {
            currentPosition = currentTurnPlayerResult.rows[0].position;
            await client.query(
                `UPDATE game_players SET is_turn = FALSE WHERE game_player_id = $1`,
                [currentTurnPlayerResult.rows[0].game_player_id]
            );
        } else {
            console.warn(`[game:${gameId}] No current turn found when advancing, defaulting. Previous logic might need check.`);
            currentPosition = -1;
        }

        const playerCountResult = await client.query(
            `SELECT COUNT(*) as count FROM game_players WHERE game_id = $1`,
            [gameId]
        );
        const playerCount = parseInt(playerCountResult.rows[0].count, 10);
        if (playerCount === 0) {
            await client.query('ROLLBACK');
            throw new Error("No players in game, cannot advance turn.");
        }

        const nextPosition = (currentPosition + 1) % playerCount;
        await client.query(
            `UPDATE game_players SET is_turn = TRUE WHERE game_id = $1 AND position = $2`,
            [gameId, nextPosition]
        );
        await client.query('COMMIT');
        console.log(`[game:${gameId}] Advanced turn to player position ${nextPosition}.`);
        return nextPosition;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[game:${gameId}] Error advancing turn:`, error);
        throw error;
    } finally {
        client.release();
    }
}

export default function handleGameConnection(io: IOServer, socket: AugmentedSocket): void { // Correctly type io and socket
    console.log(`[game] socket connected: ${socket.id}`);
    
    const userId = socket.userId;
    const username = socket.username;

    socket.on('game:join-room', async ({ gameId }, callback) => {
        if (!userId || !username) return callback?.({ error: 'Not authenticated (userId or username missing on socket)' });
        try {
            socket.join(`game:${gameId}`);
            socket.join(`user:${userId}`);
            console.log(`[game:${gameId}] User ${username} (socket ${socket.id}) joined room. User channel: user:${userId}`);
            
            const gameState = await fetchFullGameStateForClient(gameId, userId);
            if (!gameState) return callback?.({ error: 'Game not found' });
            socket.emit('game:stateUpdate', gameState);
            await broadcastGameState(io, gameId);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[game:${gameId}] Error game:join-room for ${username}:`, error);
            callback?.({ error: 'Failed to join game room' });
        }
    });

    socket.on('game:leave-room', ({ gameId }, callback) => {
        if (!userId || !username) return callback?.({ error: 'Not authenticated' });
        socket.leave(`game:${gameId}`);
        socket.leave(`user:${userId}`);
        console.log(`[game:${gameId}] User ${username} (socket ${socket.id}) left room.`);
        callback?.({ success: true });
    });

    socket.on('game:sendMessage', async ({ gameId, message }, callback) => {
        if (!userId || !username) return callback?.({ error: 'Not authenticated' });
        const trimmedMessage = message.trim();
        if (!trimmedMessage || trimmedMessage.length > 500) return callback?.({ error: 'Invalid message length' });
        try {
            const result = await pool.query(
                `INSERT INTO messages (content, author, game_id, created_at)
                 VALUES ($1, $2, $3, NOW()) RETURNING created_at`,
                [trimmedMessage, userId, gameId]
            );
            const messageData: ChatMessage = {
                content: trimmedMessage, username, created_at: result.rows[0].created_at, game_id: gameId
            };
            io.to(`game:${gameId}`).emit('game:newMessage', messageData);
            callback?.({ success: true });
        } catch (error) {
            console.error(`[game:${gameId}] Error game:sendMessage for ${username}:`, error);
            callback?.({ error: 'Failed to send message' });
        }
    });

    socket.on('game:loadMessages', async ({ gameId }, callback) => {
        if (!userId) return callback?.({ error: 'Not authenticated' });
        try {
            const result = await pool.query(
                `SELECT m.content, u.username, m.created_at
                 FROM messages m JOIN "user" u ON m.author = u.user_id
                 WHERE m.game_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
                [gameId]
            );
            socket.emit('game:loadMessages', result.rows.reverse());
            callback?.({ success: true });
        } catch (error) {
            console.error(`[game:${gameId}] Error game:loadMessages:`, error);
            callback?.({ error: 'Failed to load message history' });
        }
    });

    socket.on('game:start', async ({ gameId }, callback) => {
        if (!userId || !username) return callback?.({ error: 'Not authenticated' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const gameRes = await client.query('SELECT state, current_num_players FROM game WHERE game_id = $1 FOR UPDATE', [gameId]);
            if (!gameRes.rows.length) throw new Error('Game not found.');
            if (gameRes.rows[0].state !== 'waiting') throw new Error('Game already started or ended.');
            if (gameRes.rows[0].current_num_players < 2) throw new Error('Not enough players (min 2).');

            await client.query(`UPDATE game SET state = 'playing' WHERE game_id = $1`, [gameId]);
            const playersRes = await client.query(
                `SELECT gp.game_player_id, gp.user_id, gp.position 
                 FROM game_players gp WHERE gp.game_id = $1 ORDER BY gp.position`,
                [gameId]
            );
            const players = playersRes.rows;
            if (players.length === 0) throw new Error("No players found in game_players for this game.");

            const cardsRes = await client.query('SELECT card_id, value, shape FROM card');
            let deck: Card[] = cardsRes.rows;
            deck = deck.sort(() => Math.random() - 0.5);

            const gamePlayerIds = players.map(p => p.game_player_id);
            await client.query(`DELETE FROM cards_held WHERE game_player_id = ANY($1::int[])`, [gamePlayerIds]);

            const cardsToDealTotal = 52;
            let cardsDealtCount = 0;
            while(cardsDealtCount < cardsToDealTotal && deck.length > 0) {
                const playerToReceive = players[cardsDealtCount % players.length];
                const cardToDeal = deck.shift(); // 'card' was already declared in outer scope
                if (cardToDeal) {
                     await client.query(
                        'INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)',
                        [playerToReceive.game_player_id, cardToDeal.card_id]
                    );
                    cardsDealtCount++;
                } else {
                    break;
                }
            }
            
            activeGamePiles.set(gameId, []);
            gameLastPlayInfo.delete(gameId);

            await client.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameId]);
            await client.query(`UPDATE game_players SET is_turn = TRUE WHERE game_id = $1 AND position = 0`, [gameId]);

            await client.query('COMMIT');
            console.log(`[game:${gameId}] Game started successfully by ${username}.`);
            await broadcastGameState(io, gameId);
            callback?.({ success: true });
        } catch (error: any) {
            await client.query('ROLLBACK');
            console.error(`[game:${gameId}] Error game:start by ${username}:`, error);
            callback?.({ error: error.message || 'Failed to start game' });
        } finally {
            client.release();
        }
    });

    socket.on('game:playCards', async ({ gameId, cardsToPlayIds, declaredRank }, callback) => {
        if (!userId || !username) return callback?.({ error: 'Not authenticated' });
        const clientDb = await pool.connect();
        try {
            await clientDb.query('BEGIN');
            const playerInfoRes = await clientDb.query(
                `SELECT gp.game_player_id, gp.position, gp.is_turn 
                 FROM game_players gp WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameId, userId]
            );
            if (!playerInfoRes.rows.length) throw new Error('Player not found in this game.');
            const { game_player_id: gamePlayerId, position: playerPosition, is_turn: isTurn } = playerInfoRes.rows[0];

            if (!isTurn) throw new Error("Not your turn.");
            if (!cardsToPlayIds || !Array.isArray(cardsToPlayIds) || cardsToPlayIds.length === 0) {
                throw new Error("No cards selected/sent to play.");
            }
            if (!declaredRank) throw new Error("Declared rank is required.");

            const actualPlayedCardsDetails: Card[] = [];
            for (const cardId of cardsToPlayIds) {
                const cardDetailsRes = await clientDb.query(
                    `SELECT c.card_id, c.value, c.shape 
                     FROM card c JOIN cards_held ch ON c.card_id = ch.card_id
                     WHERE ch.game_player_id = $1 AND ch.card_id = $2`,
                    [gamePlayerId, cardId]
                );
                if(!cardDetailsRes.rows.length) throw new Error(`Card ID ${cardId} not found in your hand.`);
                actualPlayedCardsDetails.push(cardDetailsRes.rows[0]);

                const deleteResult = await clientDb.query(
                    'DELETE FROM cards_held WHERE game_player_id = $1 AND card_id = $2',
                    [gamePlayerId, cardId]
                );
                if (deleteResult.rowCount === 0) throw new Error(`Failed to remove card ${cardId} from hand.`);
            }
            
            const pile = activeGamePiles.get(gameId) || [];
            pile.push(...actualPlayedCardsDetails);
            activeGamePiles.set(gameId, pile);

            const currentPlayInfo: LastPlayInfo = {
                gamePlayerId: gamePlayerId,
                playerPosition: playerPosition,
                cardsPlayed: actualPlayedCardsDetails,
                declaredRank: declaredRank,
                cardCount: cardsToPlayIds.length
            };
            gameLastPlayInfo.set(gameId, currentPlayInfo);
            
            const remainingCardsRes = await clientDb.query(
                `SELECT COUNT(*) as count FROM cards_held WHERE game_player_id = $1`,
                [gamePlayerId]
            );
            if (parseInt(remainingCardsRes.rows[0].count, 10) === 0) {
                await clientDb.query(`UPDATE game SET state = 'ended' WHERE game_id = $1`, [gameId]);
                await clientDb.query(`UPDATE game_players SET is_winner = TRUE, is_turn = FALSE WHERE game_player_id = $1`, [gamePlayerId]);
                await clientDb.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1 AND game_player_id != $2`, [gameId, gamePlayerId]);

                console.log(`[game:${gameId}] Player ${username} (Pos: ${playerPosition}) has won!`);
                io.to(`game:${gameId}`).emit('game:gameOver', {
                    winnerPosition: playerPosition,
                    winnerUsername: username,
                    message: `Player ${username} (P${playerPosition + 1}) has played all their cards and won!`
                });
            } else {
                 await advanceTurn(gameId);
            }

            await clientDb.query('COMMIT');
            io.to(`game:${gameId}`).emit('game:actionPlayed', {
                 type: 'play',
                 playerPosition: playerPosition,
                 username: username,
                 cardCount: cardsToPlayIds.length,
                 declaredRank: declaredRank,
            });
            await broadcastGameState(io, gameId);
            callback?.({ success: true });
        } catch (error: any) {
            await clientDb.query('ROLLBACK');
            console.error(`[game:${gameId}] Error game:playCards for ${username}:`, error);
            callback?.({ error: error.message || 'Failed to play cards' });
        } finally {
            clientDb.release();
        }
    });

    socket.on('game:callBS', async ({ gameId }, callback) => {
        if (!userId || !username) return callback?.({ error: 'Not authenticated' });
        const clientDb = await pool.connect();
        try {
            await clientDb.query('BEGIN');
            const callerInfoRes = await clientDb.query(
                `SELECT gp.game_player_id, gp.position, gp.is_turn 
                 FROM game_players gp WHERE gp.game_id = $1 AND gp.user_id = $2`,
                [gameId, userId]
            );
            if (!callerInfoRes.rows.length) throw new Error('Caller not found in this game.');
            const { game_player_id: callerGamePlayerId, position: callerPosition, is_turn: isCallersTurn } = callerInfoRes.rows[0];

            if (!isCallersTurn) throw new Error("Not your turn to call BS.");

            const lastPlay = gameLastPlayInfo.get(gameId);
            if (!lastPlay) throw new Error('No play to call BS on.');
            if (lastPlay.gamePlayerId === callerGamePlayerId) throw new Error("Cannot call BS on your own play.");

            const {
                gamePlayerId: challengedGamePlayerId,
                playerPosition: challengedPlayerPosition,
                cardsPlayed: actualCardsInLastPlay,
                declaredRank,
            } = lastPlay;

            let wasBluff = false;
            const rankMap: { [key: string]: number } = { 'A':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13 };
            const declaredNumericRank = rankMap[declaredRank.toUpperCase()];
            if (isNaN(declaredNumericRank)) throw new Error("Invalid declared rank format in the last play data.");

            for (const cardInPlay of actualCardsInLastPlay) { // Renamed 'card' to 'cardInPlay' to avoid conflict
                if (cardInPlay.value !== declaredNumericRank) {
                    wasBluff = true;
                    break;
                }
            }

            const pile = activeGamePiles.get(gameId) || [];
            let pileReceiverGamePlayerId: number;
            let pileReceiverPosition: number;
            let eventMessage: string;

            const challengedPlayerDbRes = await clientDb.query(
                `SELECT u.username FROM "user" u JOIN game_players gp ON u.user_id = gp.user_id WHERE gp.game_player_id = $1`,
                [challengedGamePlayerId]
            );
            const challengedUsername = challengedPlayerDbRes.rows.length ? challengedPlayerDbRes.rows[0].username : `P${challengedPlayerPosition+1}`;
            const callerUsername = username;

            if (wasBluff) {
                pileReceiverGamePlayerId = challengedGamePlayerId;
                pileReceiverPosition = challengedPlayerPosition;
                eventMessage = `${callerUsername} (P${callerPosition + 1}) called BS! ${challengedUsername} (P${challengedPlayerPosition + 1}) WAS bluffing and takes the pile.`;
            } else {
                pileReceiverGamePlayerId = callerGamePlayerId;
                pileReceiverPosition = callerPosition;
                eventMessage = `${callerUsername} (P${callerPosition + 1}) called BS! ${challengedUsername} (P${challengedPlayerPosition + 1}) was NOT bluffing. ${callerUsername} takes the pile.`;
            }

            for (const cardInPile of pile) {
                await clientDb.query(
                    'INSERT INTO cards_held (game_player_id, card_id) VALUES ($1, $2)',
                    [pileReceiverGamePlayerId, cardInPile.card_id]
                );
            }
            activeGamePiles.set(gameId, []);
            gameLastPlayInfo.delete(gameId);

            await clientDb.query(`UPDATE game_players SET is_turn = FALSE WHERE game_id = $1`, [gameId]);
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
            await clientDb.query('ROLLBACK');
            console.error(`[game:${gameId}] Error game:callBS for ${username}:`, error);
            callback?.({ error: error.message || 'Failed to process BS call' });
        } finally {
            clientDb.release();
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[game] socket ${socket.id} (${username || 'User (details unavailable)'}) disconnected: ${reason}`);
    });
}
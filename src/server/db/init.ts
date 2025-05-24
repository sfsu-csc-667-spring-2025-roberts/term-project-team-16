// src/server/db/init.ts - Minimal version with required BS game features
import pool from '../config/database';

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Creating BS Game database...');

    // User table (unchanged)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "user" (
        user_id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        signed_in BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Game table - MUST include last play tracking for BS calls
    await client.query(`
      CREATE TABLE IF NOT EXISTS game (
        game_id SERIAL PRIMARY KEY,
        max_num_players INTEGER NOT NULL DEFAULT 4,
        current_num_players INTEGER DEFAULT 0,
        state VARCHAR(50) DEFAULT 'waiting',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        -- CRITICAL: Last play tracking for BS calls on disconnected players
        last_play_player_id INTEGER,
        last_play_declared_rank VARCHAR(3),
        last_play_card_count INTEGER,
        last_play_timestamp BIGINT,
        
        CONSTRAINT game_max_players_check CHECK (max_num_players >= 2 AND max_num_players <= 8),
        CONSTRAINT game_current_players_check CHECK (current_num_players >= 0 AND current_num_players <= max_num_players),
        CONSTRAINT game_state_check CHECK (state IN ('waiting', 'playing', 'pending_win', 'ended'))
      )
    `);

    // GamePlayers table (unchanged)
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        game_player_id SERIAL PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES game(game_id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES "user"(user_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        is_winner BOOLEAN DEFAULT FALSE,
        is_turn BOOLEAN DEFAULT FALSE,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        CONSTRAINT unique_game_user UNIQUE (game_id, user_id),
        CONSTRAINT unique_game_position UNIQUE (game_id, position)
      )
    `);

    // Card table (unchanged)
    await client.query(`
      CREATE TABLE IF NOT EXISTS card (
        card_id SERIAL PRIMARY KEY,
        value INTEGER NOT NULL,
        shape VARCHAR(20) NOT NULL,
        
        CONSTRAINT card_value_check CHECK (value >= 1 AND value <= 13),
        CONSTRAINT card_shape_check CHECK (shape IN ('hearts', 'diamonds', 'clubs', 'spades')),
        CONSTRAINT unique_card UNIQUE (value, shape)
      )
    `);

    // CRITICAL: CardsHeld table MUST support pile (game_player_id = 0)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards_held (
        card_held_id SERIAL PRIMARY KEY,
        game_player_id INTEGER NOT NULL,
        card_id INTEGER NOT NULL REFERENCES card(card_id) ON DELETE CASCADE,
        held_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        -- CRITICAL: Allow game_player_id = 0 for pile, no FK constraint
        CONSTRAINT cards_held_player_check CHECK (game_player_id >= 0),
        CONSTRAINT unique_card_holder UNIQUE (game_player_id, card_id)
      )
    `);

    // Messages table - allow NULL game_id for lobby messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        author INTEGER NOT NULL REFERENCES "user"(user_id) ON DELETE CASCADE,
        game_id INTEGER REFERENCES game(game_id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        -- game_id NULL = lobby message, non-NULL = game-specific message
        CONSTRAINT message_content_check CHECK (LENGTH(content) > 0 AND LENGTH(content) <= 1000)
      )
    `);

    // Sessions table (unchanged)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES "user"(user_id) ON DELETE CASCADE,
        session_token VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL
      )
    `);

    // Initialize card deck (52 cards)
    console.log('Initializing card deck...');
    await client.query(`
      INSERT INTO card (value, shape)
      SELECT v.value, s.shape
      FROM (
        SELECT 1 AS value UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 
        UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13
      ) v
      CROSS JOIN (
        SELECT 'hearts' AS shape UNION SELECT 'diamonds' 
        UNION SELECT 'clubs' UNION SELECT 'spades'
      ) s
      WHERE NOT EXISTS (SELECT 1 FROM card WHERE card.value = v.value AND card.shape = s.shape)
    `);

    // Essential indexes for BS game performance
    console.log('Creating essential indexes...');
    const indexes = [
      // Game state indexes
      'CREATE INDEX IF NOT EXISTS idx_game_state ON game(state)',
      'CREATE INDEX IF NOT EXISTS idx_game_last_play ON game(game_id, last_play_player_id)',
      
      // Player indexes
      'CREATE INDEX IF NOT EXISTS idx_game_players_game_user ON game_players(game_id, user_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_one_turn_per_game ON game_players(game_id) WHERE is_turn = TRUE',
      
      // CRITICAL: Cards held indexes (especially for pile operations)
      'CREATE INDEX IF NOT EXISTS idx_cards_held_player ON cards_held(game_player_id)',
      'CREATE INDEX IF NOT EXISTS idx_cards_held_pile ON cards_held(game_player_id) WHERE game_player_id = 0',
      
      // Chat and session indexes
      'CREATE INDEX IF NOT EXISTS idx_messages_game_created ON messages(game_id, created_at DESC) WHERE game_id IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_messages_lobby ON messages(created_at DESC) WHERE game_id IS NULL',
      'CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token)'
    ];

    for (const indexQuery of indexes) {
      try {
        await client.query(indexQuery);
      } catch (error: any) {
        console.warn(`Warning creating index: ${error.message}`);
      }
    }

    await client.query('COMMIT');
    console.log('Database initialized successfully with BS game features');
    console.log('✅ Pile persistence enabled (game_player_id = 0)');
    console.log('✅ Last play tracking enabled for BS calls');
    console.log('✅ Lobby messages enabled (game_id = NULL)');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

export default initializeDatabase;
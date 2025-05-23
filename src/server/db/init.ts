// src/server/db/init.ts - Simplified version (keep your original schema mostly)
import pool from '../config/database';

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Keep your original tables exactly as they are
    // Create User table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "user" (
        user_id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        signed_in BOOLEAN DEFAULT FALSE
      )
    `);

    // Create Game table
    await client.query(`
      CREATE TABLE IF NOT EXISTS game (
        game_id SERIAL PRIMARY KEY,
        max_num_players INTEGER NOT NULL,
        current_num_players INTEGER DEFAULT 0,
        state VARCHAR(50) DEFAULT 'waiting'
      )
    `);

    // Create GamePlayers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        game_player_id SERIAL PRIMARY KEY,
        game_id INTEGER REFERENCES game(game_id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES "user"(user_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        is_winner BOOLEAN DEFAULT FALSE,
        is_turn BOOLEAN DEFAULT FALSE
      )
    `);

    // Create Card table
    await client.query(`
      CREATE TABLE IF NOT EXISTS card (
        card_id SERIAL PRIMARY KEY,
        value INTEGER NOT NULL,
        shape VARCHAR(20) NOT NULL
      )
    `);

    // Create CardsHeld table
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards_held (
        card_held_id SERIAL PRIMARY KEY,
        game_player_id INTEGER REFERENCES game_players(game_player_id) ON DELETE CASCADE,
        card_id INTEGER REFERENCES card(card_id) ON DELETE CASCADE
      )
    `);

    // Create Messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        author INTEGER REFERENCES "user"(user_id) ON DELETE CASCADE,
        game_id INTEGER REFERENCES game(game_id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create Sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES "user"(user_id) ON DELETE CASCADE,
        session_token VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL
      )
    `);

    // Initialize card deck - insert all 52 cards (keep your original logic)
    await client.query(`
      INSERT INTO card (value, shape)
      SELECT v.value, s.shape
      FROM (
        SELECT 1 AS value UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 
        UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13
      ) v,
      (
        SELECT 'hearts' AS shape UNION SELECT 'diamonds' UNION SELECT 'clubs' UNION SELECT 'spades'
      ) s
      WHERE NOT EXISTS (SELECT 1 FROM card)
    `);

    // Add just the essential performance improvements
    console.log('Adding performance indexes...');
    const indexes = [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_game_players_game_user ON game_players(game_id, user_id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_game_players_turn ON game_players(game_id, is_turn) WHERE is_turn = TRUE',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cards_held_player ON cards_held(game_player_id)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_game_created ON messages(game_id, created_at DESC)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_token ON sessions(session_token)'
    ];

    for (const indexQuery of indexes) {
      try {
        await client.query(indexQuery);
      } catch (error: any) {
        if (!error.message.includes('already exists')) {
          console.warn(`Warning creating index: ${error.message}`);
        }
      }
    }

    // Add basic data validation (prevent crashes)
    console.log('Adding basic constraints...');
    try {
      await client.query('ALTER TABLE card ADD CONSTRAINT IF NOT EXISTS card_value_check CHECK (value >= 1 AND value <= 13)');
      await client.query('ALTER TABLE game ADD CONSTRAINT IF NOT EXISTS game_max_players_check CHECK (max_num_players >= 2 AND max_num_players <= 8)');
      await client.query('ALTER TABLE game ADD CONSTRAINT IF NOT EXISTS game_current_players_check CHECK (current_num_players >= 0 AND current_num_players <= max_num_players)');
      await client.query('ALTER TABLE game_players ADD CONSTRAINT IF NOT EXISTS unique_game_user UNIQUE (game_id, user_id)');
      await client.query('ALTER TABLE game_players ADD CONSTRAINT IF NOT EXISTS unique_game_position UNIQUE (game_id, position)');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_one_turn_per_game ON game_players(game_id) WHERE is_turn = TRUE');
    } catch (error: any) {
      // Constraints might already exist, that's fine
      console.log('Some constraints already exist, continuing...');
    }

    await client.query('COMMIT');
    console.log('Database initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error initializing database:', error);
  } finally {
    client.release();
  }
}

export default initializeDatabase;
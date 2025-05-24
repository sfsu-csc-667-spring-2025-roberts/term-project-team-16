// src/server/db/init.ts - Enhanced with game-specific pile support for multi-game isolation
import pool from '../config/database';

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Creating BS Game database with multi-game pile isolation...');

    // User table
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

    // Game table - includes last play tracking for BS calls on disconnected players
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

    // GamePlayers table
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

    // Card table
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

    // This prevents pile collision between simultaneous games
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards_held (
        card_held_id SERIAL PRIMARY KEY,
        game_player_id INTEGER NOT NULL,
        card_id INTEGER NOT NULL REFERENCES card(card_id) ON DELETE CASCADE,
        held_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        -- 🔧 MULTI-GAME PILE SYSTEM:
        -- Positive values: Real players (1, 2, 3, ...)
        -- Negative values: Game-specific piles (-1 = Game 1, -2 = Game 2, ...)
        -- Zero is no longer used (prevents collision)
        CONSTRAINT cards_held_player_check CHECK (game_player_id != 0),
        CONSTRAINT unique_card_holder UNIQUE (game_player_id, card_id)
      )
    `);

    // Messages table - supports both lobby (NULL game_id) and game-specific messages
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

    // Sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES "user"(user_id) ON DELETE CASCADE,
        session_token VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL
      )
    `);

    // Initialize card deck (52 standard playing cards)
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

    console.log('Creating performance indexes...');
    const indexes = [
      // Game state indexes
      'CREATE INDEX IF NOT EXISTS idx_game_state ON game(state)',
      'CREATE INDEX IF NOT EXISTS idx_game_last_play ON game(game_id, last_play_player_id)',
      
      // Player indexes
      'CREATE INDEX IF NOT EXISTS idx_game_players_game_user ON game_players(game_id, user_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_one_turn_per_game ON game_players(game_id) WHERE is_turn = TRUE',
      
      'CREATE INDEX IF NOT EXISTS idx_cards_held_players ON cards_held(game_player_id) WHERE game_player_id > 0',
      'CREATE INDEX IF NOT EXISTS idx_cards_held_game_piles ON cards_held(game_player_id) WHERE game_player_id < 0',
      'CREATE INDEX IF NOT EXISTS idx_cards_held_pile_order ON cards_held(game_player_id, held_at) WHERE game_player_id < 0',
      
      // Chat indexes for lobby/game separation
      'CREATE INDEX IF NOT EXISTS idx_messages_game_created ON messages(game_id, created_at DESC) WHERE game_id IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_messages_lobby ON messages(created_at DESC) WHERE game_id IS NULL',
      
      // Session indexes
      'CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON sessions(user_id, expires_at)'
    ];

    for (const indexQuery of indexes) {
      try {
        await client.query(indexQuery);
      } catch (error: any) {
        console.warn(`Warning creating index: ${error.message}`);
      }
    }

    // 🔧 ADD: Helpful views for debugging multi-game state
    console.log('Creating debugging views...');
    
    // Game state overview
    await client.query(`
      CREATE OR REPLACE VIEW game_state_debug AS
      SELECT 
        g.game_id,
        g.state as game_state,
        g.current_num_players,
        g.max_num_players,
        g.created_at as game_created,
        
        -- Last play info
        g.last_play_player_id,
        g.last_play_declared_rank,
        g.last_play_card_count,
        CASE 
          WHEN g.last_play_timestamp IS NOT NULL 
          THEN to_timestamp(g.last_play_timestamp / 1000.0)
          ELSE NULL 
        END as last_play_time,
        
        -- Pile info (game-specific)
        (SELECT COUNT(*) FROM cards_held WHERE game_player_id = -g.game_id) as pile_count,
        (SELECT COUNT(*) FROM cards_held ch 
         JOIN game_players gp ON ch.game_player_id = gp.game_player_id 
         WHERE gp.game_id = g.game_id) as total_player_cards,
        
        -- Player info
        (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.game_id) as actual_players,
        (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.game_id AND gp.is_turn = TRUE) as players_with_turn,
        (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.game_id AND gp.is_winner = TRUE) as winners
      FROM game g
      ORDER BY g.game_id
    `);

    // Multi-game pile overview
    await client.query(`
      CREATE OR REPLACE VIEW pile_overview_debug AS
      SELECT 
        CASE 
          WHEN game_player_id > 0 THEN 'Player ' || game_player_id
          WHEN game_player_id < 0 THEN 'Game ' || ABS(game_player_id) || ' Pile'
          ELSE 'Unknown'
        END as holder,
        game_player_id,
        COUNT(*) as card_count,
        MIN(held_at) as first_card_time,
        MAX(held_at) as last_card_time
      FROM cards_held 
      GROUP BY game_player_id 
      ORDER BY game_player_id
    `);

    // 🔧 ADD: Utility function for multi-game integrity checking
    await client.query(`
      CREATE OR REPLACE FUNCTION check_multi_game_integrity()
      RETURNS TABLE(
        issue_type TEXT,
        game_id INTEGER,
        description TEXT,
        severity TEXT
      ) AS $$
      BEGIN
        -- Check for games with no turn holder
        RETURN QUERY
        SELECT 
          'NO_TURN_HOLDER'::TEXT,
          g.game_id,
          'Game in playing state but no player has turn'::TEXT,
          'HIGH'::TEXT
        FROM game g
        WHERE g.state = 'playing'
        AND NOT EXISTS (
          SELECT 1 FROM game_players gp 
          WHERE gp.game_id = g.game_id AND gp.is_turn = TRUE AND gp.is_winner = FALSE
        );

        -- Check for pile isolation (no cross-game pile pollution)
        RETURN QUERY
        SELECT 
          'PILE_ISOLATION_VIOLATION'::TEXT,
          ABS(ch.game_player_id),
          'Game pile contains cards but game does not exist or is ended'::TEXT,
          'MEDIUM'::TEXT
        FROM cards_held ch
        WHERE ch.game_player_id < 0
        AND NOT EXISTS (
          SELECT 1 FROM game g 
          WHERE g.game_id = ABS(ch.game_player_id) 
          AND g.state IN ('playing', 'pending_win')
        );

        -- Check for card count anomalies per game
        RETURN QUERY
        SELECT 
          'CARD_COUNT_ANOMALY'::TEXT,
          g.game_id,
          'Total cards in game != 52'::TEXT,
          'MEDIUM'::TEXT
        FROM game g
        WHERE g.state IN ('playing', 'pending_win')
        AND (
          (SELECT COUNT(*) FROM cards_held ch 
           JOIN game_players gp ON ch.game_player_id = gp.game_player_id 
           WHERE gp.game_id = g.game_id) +
          (SELECT COUNT(*) FROM cards_held ch WHERE ch.game_player_id = -g.game_id)
        ) != 52;

        -- Check for multiple turn holders per game
        RETURN QUERY
        SELECT 
          'MULTIPLE_TURNS'::TEXT,
          g.game_id,
          'Multiple players have turn in same game'::TEXT,
          'HIGH'::TEXT
        FROM game g
        WHERE (
          SELECT COUNT(*) FROM game_players gp 
          WHERE gp.game_id = g.game_id AND gp.is_turn = TRUE
        ) > 1;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 🔧 ADD: Cleanup function for ended games
    await client.query(`
      CREATE OR REPLACE FUNCTION cleanup_ended_games()
      RETURNS TABLE(
        action TEXT,
        count INTEGER
      ) AS $$
      DECLARE
        pile_cleanup_count INTEGER := 0;
        last_play_cleanup_count INTEGER := 0;
        session_cleanup_count INTEGER := 0;
      BEGIN
        -- Clean up pile cards from ended games
        DELETE FROM cards_held 
        WHERE game_player_id < 0 
        AND ABS(game_player_id) IN (
          SELECT game_id FROM game WHERE state = 'ended'
        );
        GET DIAGNOSTICS pile_cleanup_count = ROW_COUNT;
        
        -- Clear last play info from ended games
        UPDATE game SET 
          last_play_player_id = NULL,
          last_play_declared_rank = NULL,
          last_play_card_count = NULL,
          last_play_timestamp = NULL
        WHERE state = 'ended';
        GET DIAGNOSTICS last_play_cleanup_count = ROW_COUNT;
        
        -- Clean up expired sessions
        DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP;
        GET DIAGNOSTICS session_cleanup_count = ROW_COUNT;
        
        RETURN QUERY VALUES 
          ('pile_cards_cleaned', pile_cleanup_count),
          ('last_play_cleared', last_play_cleanup_count),
          ('sessions_expired', session_cleanup_count);
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query('COMMIT');
    
    console.log(' Database initialized successfully with multi-game BS support!');
    console.log('');
    console.log(' KEY FEATURES:');
    console.log('   Game-specific pile isolation (Game 1 = pile -1, Game 2 = pile -2, etc.)');
    console.log('   Last play tracking for BS calls on disconnected players');
    console.log('   Lobby vs game message separation (game_id NULL vs specific)');
    console.log('  Multi-game performance indexes');
    console.log('  Debugging views and integrity checking');
    console.log('');
    console.log(' DEBUGGING COMMANDS:');
    console.log('   Game overview: SELECT * FROM game_state_debug;');
    console.log('   Pile overview: SELECT * FROM pile_overview_debug;');
    console.log('   Integrity check: SELECT * FROM check_multi_game_integrity();');
    console.log('   Cleanup ended games: SELECT * FROM cleanup_ended_games();');
    console.log('');
    console.log('Ready for multi-game BS with perfect isolation!');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

export default initializeDatabase;
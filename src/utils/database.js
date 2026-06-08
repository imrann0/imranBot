const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: process.env.DB_PORT ?? 5432,
  user: process.env.DB_USER ?? 'sekai',
  password: process.env.DB_PASSWORD ?? 'sifre123',
  database: process.env.DB_NAME ?? 'sekaibot',
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity (
      user_id            TEXT PRIMARY KEY,
      username           TEXT NOT NULL,
      messages           INTEGER DEFAULT 0,
      voice_seconds      BIGINT DEFAULT 0,
      voice_joined_at    BIGINT,
      voice_channel_id   TEXT,
      voice_channel_name TEXT,
      last_seen          TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id                 SERIAL PRIMARY KEY,
      user_id            TEXT NOT NULL,
      username           TEXT NOT NULL,
      channel_id         TEXT NOT NULL,
      channel_name       TEXT NOT NULL,
      content            TEXT NOT NULL,
      reply_to_user_id   TEXT,
      reply_to_username  TEXT,
      reply_to_content   TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_logs (
      id               SERIAL PRIMARY KEY,
      guild_id         TEXT NOT NULL DEFAULT '',
      user_id          TEXT NOT NULL,
      username         TEXT NOT NULL,
      channel_id       TEXT NOT NULL,
      channel_name     TEXT NOT NULL,
      joined_at        TIMESTAMPTZ NOT NULL,
      left_at          TIMESTAMPTZ NOT NULL,
      duration_seconds BIGINT NOT NULL,
      active_seconds   BIGINT DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mod_logs (
      id                  SERIAL PRIMARY KEY,
      action_type         TEXT NOT NULL,
      target_user_id      TEXT NOT NULL,
      target_username     TEXT NOT NULL,
      executor_user_id    TEXT,
      executor_username   TEXT,
      reason              TEXT,
      duration_seconds    BIGINT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_hours (
      user_id  TEXT NOT NULL,
      hour     SMALLINT NOT NULL,
      count    INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, hour)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channel_stats (
      user_id      TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      count        INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, channel_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_roles (
      role_id    TEXT PRIMARY KEY,
      role_name  TEXT NOT NULL,
      added_by   TEXT,
      added_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                   SERIAL PRIMARY KEY,
      title                TEXT NOT NULL,
      description          TEXT,
      priority             TEXT DEFAULT 'orta',
      due_date             TEXT,
      assigned_to_id       TEXT,
      assigned_to_username TEXT,
      assigned_role_id     TEXT,
      assigned_role_name   TEXT,
      requirements         JSONB DEFAULT '{}',
      created_by_id        TEXT NOT NULL,
      created_by_username  TEXT NOT NULL,
      status               TEXT DEFAULT 'bekliyor',
      message_id           TEXT,
      channel_id           TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_log_channels (
      channel_id   TEXT PRIMARY KEY,
      channel_name TEXT NOT NULL,
      added_by     TEXT,
      added_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_point_logs (
      id           SERIAL PRIMARY KEY,
      user_id      TEXT NOT NULL,
      username     TEXT NOT NULL,
      points       INTEGER NOT NULL,
      reason       TEXT,
      given_by_id  TEXT NOT NULL,
      given_by     TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      id           SERIAL PRIMARY KEY,
      task_id      INTEGER NOT NULL,
      user_id      TEXT NOT NULL,
      username     TEXT NOT NULL,
      status       TEXT DEFAULT 'bekliyor',
      assigned_at  TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE(task_id, user_id)
    )
  `);

  // Migration
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_role_ids JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requirements JSONB DEFAULT '{}'`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 25`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence TEXT`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_recurrence TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date TEXT`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_notes (
      id         SERIAL PRIMARY KEY,
      task_id    INTEGER NOT NULL,
      user_id    TEXT NOT NULL,
      username   TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id                   SERIAL PRIMARY KEY,
      name                 TEXT NOT NULL,
      type                 TEXT NOT NULL DEFAULT 'manuel',
      priority             TEXT NOT NULL DEFAULT 'orta',
      points               INTEGER DEFAULT 25,
      description          TEXT,
      requirements         TEXT,
      created_by_id        TEXT NOT NULL,
      created_by_username  TEXT NOT NULL,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS confessions (
      id         SERIAL PRIMARY KEY,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migration: guild_id kolonları ekle
  await pool.query(`ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE staff_roles ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE blocked_log_channels ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE voice_logs ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE mod_logs ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE activity_hours ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE channel_stats ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE task_templates ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE manual_point_logs ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE confessions ADD COLUMN IF NOT EXISTS guild_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE confessions ADD COLUMN IF NOT EXISTS user_id TEXT`);

  // (eski UNIQUE constraint'ler PK'ye dönüştürüldü, bu blok artık boş bırakıldı)

  // Migration: tüm tek kolonlu PK'leri composite (guild_id + ...) PK'ye çevir
  await pool.query(`
    DO $$ BEGIN
      -- guild_config: key → (guild_id, key)
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_pkey') THEN
        ALTER TABLE guild_config DROP CONSTRAINT guild_config_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guild_config_guild_key_pkey') THEN
        ALTER TABLE guild_config ADD CONSTRAINT guild_config_guild_key_pkey PRIMARY KEY (guild_id, key);
      END IF;

      -- staff_roles: role_id → (guild_id, role_id)
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_roles_pkey') THEN
        ALTER TABLE staff_roles DROP CONSTRAINT staff_roles_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_roles_guild_role_pkey') THEN
        ALTER TABLE staff_roles ADD CONSTRAINT staff_roles_guild_role_pkey PRIMARY KEY (guild_id, role_id);
      END IF;

      -- blocked_log_channels: channel_id → (guild_id, channel_id)
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocked_log_channels_pkey') THEN
        ALTER TABLE blocked_log_channels DROP CONSTRAINT blocked_log_channels_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blocked_log_guild_channel_pkey') THEN
        ALTER TABLE blocked_log_channels ADD CONSTRAINT blocked_log_guild_channel_pkey PRIMARY KEY (guild_id, channel_id);
      END IF;

      -- activity: user_id → (guild_id, user_id)
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_pkey') THEN
        ALTER TABLE activity DROP CONSTRAINT activity_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_guild_user_pkey') THEN
        ALTER TABLE activity ADD CONSTRAINT activity_guild_user_pkey PRIMARY KEY (guild_id, user_id);
      END IF;

      -- activity_hours: (user_id, hour) → (guild_id, user_id, hour)
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_hours_pkey') THEN
        ALTER TABLE activity_hours DROP CONSTRAINT activity_hours_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_hours_guild_pkey') THEN
        ALTER TABLE activity_hours ADD CONSTRAINT activity_hours_guild_pkey PRIMARY KEY (guild_id, user_id, hour);
      END IF;

      -- channel_stats: (user_id, channel_id) → (guild_id, user_id, channel_id)
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_stats_pkey') THEN
        ALTER TABLE channel_stats DROP CONSTRAINT channel_stats_pkey;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channel_stats_guild_pkey') THEN
        ALTER TABLE channel_stats ADD CONSTRAINT channel_stats_guild_pkey PRIMARY KEY (guild_id, user_id, channel_id);
      END IF;
    END $$;
  `);

  // Migration: mevcut tablolara eksik kolonlar
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS voice_channel_id TEXT`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS voice_channel_name TEXT`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS task_points INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS message_score INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS voice_score INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS manual_points INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS voice_mic_on_at BIGINT`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS voice_active_seconds BIGINT DEFAULT 0`);
  await pool.query(`ALTER TABLE voice_logs ADD COLUMN IF NOT EXISTS active_seconds BIGINT DEFAULT 0`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS responsibility_points INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE activity ADD COLUMN IF NOT EXISTS mandatory_task_points INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category TEXT`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS xp_limit INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS original_task_id INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS type TEXT`);
  await pool.query(`ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS score NUMERIC DEFAULT 0`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_categories (
      guild_id  TEXT NOT NULL,
      name      TEXT NOT NULL,
      total_cap INTEGER NOT NULL DEFAULT 25,
      PRIMARY KEY (guild_id, name)
    )
  `);

  // Migration: puan kolonlarını NUMERIC(12,2)'ye dönüştür (küsüratlı puan desteği)
  // Her kolon ayrı ayrı — zaten NUMERIC ise hata yakalanıp geçilir
  for (const col of [
    'message_score', 'voice_score', 'manual_points',
    'task_points', 'mandatory_task_points', 'responsibility_points',
  ]) {
    await pool.query(
      `ALTER TABLE activity ALTER COLUMN ${col} TYPE NUMERIC(12,2) USING ${col}::NUMERIC(12,2)`
    ).catch(() => {}); // zaten NUMERIC ise atla
  }

  // ── Gelişmiş Yetki Sistemi Tabloları ─────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_roles (
      id                    SERIAL PRIMARY KEY,
      guild_id              TEXT NOT NULL,
      role_id               TEXT NOT NULL,
      role_name             TEXT NOT NULL,
      xp_required           INTEGER NOT NULL DEFAULT 100,
      responsibility_limit  INTEGER NOT NULL DEFAULT 3,
      xp_multiplier         NUMERIC(4,2) NOT NULL DEFAULT 1.0,
      weekly_tasks_required INTEGER NOT NULL DEFAULT 1,
      task_period_weeks     INTEGER NOT NULL DEFAULT 1,
      position              INTEGER NOT NULL DEFAULT 0,
      UNIQUE(guild_id, role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_types (
      id                SERIAL PRIMARY KEY,
      guild_id          TEXT NOT NULL,
      name              TEXT NOT NULL,
      xp_per_completion INTEGER NOT NULL DEFAULT 10,
      max_cap           INTEGER NOT NULL DEFAULT 25,
      UNIQUE(guild_id, name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_completions (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      type_name   TEXT NOT NULL,
      week_number INTEGER NOT NULL,
      year        INTEGER NOT NULL,
      count       INTEGER DEFAULT 1,
      xp_earned   INTEGER DEFAULT 0,
      approved_by TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_mandatory (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      week_number INTEGER NOT NULL,
      year        INTEGER NOT NULL,
      completed   BOOLEAN DEFAULT FALSE,
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      UNIQUE(guild_id, user_id, week_number, year)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_users (
      guild_id         TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      username         TEXT NOT NULL,
      current_xp       INTEGER DEFAULT 0,
      streak           INTEGER DEFAULT 0,
      last_active_week INTEGER,
      last_active_year INTEGER,
      warning_count    INTEGER DEFAULT 0,
      last_warned_at   TIMESTAMPTZ,
      PRIMARY KEY(guild_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rs_warnings (
      id             SERIAL PRIMARY KEY,
      guild_id       TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      username       TEXT NOT NULL,
      week_number    INTEGER NOT NULL,
      year           INTEGER NOT NULL,
      warning_number INTEGER NOT NULL,
      reason         TEXT,
      sent_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS command_permissions (
      guild_id     TEXT NOT NULL,
      command_name TEXT NOT NULL,
      role_id      TEXT NOT NULL,
      PRIMARY KEY (guild_id, command_name, role_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partnership_logs (
      id         SERIAL PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      username   TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS promotion_requests (
      id             SERIAL PRIMARY KEY,
      guild_id       TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      username       TEXT NOT NULL,
      target_role_id TEXT NOT NULL,
      requested_at   TIMESTAMPTZ DEFAULT NOW(),
      status         TEXT NOT NULL DEFAULT 'bekliyor',
      resolved_at    TIMESTAMPTZ,
      resolved_by    TEXT
    )
  `);

  // ── Yeni özellikler için migration ───────────────────────────
  // XP log tablosu (mesaj/ses hariç anlamlı XP olayları)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xp_log (
      id         SERIAL PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      username   TEXT,
      type       TEXT NOT NULL,
      amount     NUMERIC NOT NULL,
      reason     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_xp_log_guild_user ON xp_log(guild_id, user_id)`);

  // Deadline hatırlatıcı takibi (tasks tablosuna kolon ekle)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ`);

  // task_templates — şablon kaydetme özelliği için eksik kolonlar
  await pool.query(`ALTER TABLE task_templates ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE task_templates ADD COLUMN IF NOT EXISTS category TEXT`);
  await pool.query(`ALTER TABLE task_templates ADD COLUMN IF NOT EXISTS xp_limit INTEGER DEFAULT NULL`);
  await pool.query(`ALTER TABLE task_templates ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE task_templates ADD COLUMN IF NOT EXISTS recurrence TEXT`);

  // ── Sezon sistemi ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seasons (
      id         SERIAL PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      name       TEXT NOT NULL,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at   TIMESTAMPTZ,
      is_active  BOOLEAN DEFAULT TRUE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS season_snapshots (
      id                    SERIAL PRIMARY KEY,
      season_id             INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      guild_id              TEXT NOT NULL,
      user_id               TEXT NOT NULL,
      username              TEXT NOT NULL,
      messages              INTEGER NOT NULL DEFAULT 0,
      voice_seconds         BIGINT NOT NULL DEFAULT 0,
      message_score         NUMERIC NOT NULL DEFAULT 0,
      voice_score           NUMERIC NOT NULL DEFAULT 0,
      task_points           NUMERIC NOT NULL DEFAULT 0,
      mandatory_task_points NUMERIC NOT NULL DEFAULT 0,
      responsibility_points NUMERIC NOT NULL DEFAULT 0,
      manual_points         NUMERIC NOT NULL DEFAULT 0,
      total_score           NUMERIC NOT NULL DEFAULT 0,
      final_rank            INTEGER,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('✅ Veritabanı hazır.');
}

module.exports = { pool, init };

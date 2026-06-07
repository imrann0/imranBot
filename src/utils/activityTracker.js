const { pool } = require('./database');
const { EmbedBuilder } = require('discord.js');

async function ensureUser(guildId, userId, username) {
  await pool.query(`
    INSERT INTO activity (guild_id, user_id, username, last_seen)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET username = $3
  `, [guildId, userId, username]);
}

// Tüm puan config'ini DB'den çeker; eksik olanlar için varsayılan döner
async function getScoreConfig(guildId) {
  const keys = [
    'score_msg_base', 'score_msg_min_chars', 'score_msg_min_words',
    'score_msg_word_threshold', 'score_msg_word_bonus',
    'score_msg_char_threshold', 'score_msg_char_bonus',
    'score_voice_per_min',
  ];
  const res = await pool.query(
    `SELECT key, value FROM guild_config WHERE guild_id = $1 AND key = ANY($2)`, [guildId, keys]
  );
  const m = Object.fromEntries(res.rows.map(r => [r.key, parseFloat(r.value)]));
  return {
    msg_base:           m.score_msg_base           ?? 0.1,  // mesaj başına puan
    msg_min_chars:      m.score_msg_min_chars       ?? 5,
    msg_min_words:      m.score_msg_min_words       ?? 1,
    msg_word_threshold: m.score_msg_word_threshold  ?? 10,
    msg_word_bonus:     m.score_msg_word_bonus      ?? 0.1, // uzun mesaj bonusu
    msg_char_threshold: m.score_msg_char_threshold  ?? 100,
    msg_char_bonus:     m.score_msg_char_bonus      ?? 0.1, // uzun mesaj karakter bonusu
    voice_per_min:      m.score_voice_per_min       ?? 0.5, // dakika başına ses puanı
  };
}

function calcMessageScore(content, cfg) {
  const chars = content.trim().length;
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  if (chars < cfg.msg_min_chars || words < cfg.msg_min_words) return 0;
  let score = cfg.msg_base;
  if (words >= cfg.msg_word_threshold) score += cfg.msg_word_bonus;
  if (chars >= cfg.msg_char_threshold) score += cfg.msg_char_bonus;
  return Math.round(score * 100) / 100; // 2 ondalık basamak
}

async function addMessage(guildId, userId, username, channelId, channelName, content = '') {
  await ensureUser(guildId, userId, username);

  const cfg = await getScoreConfig(guildId);
  const pts = calcMessageScore(content, cfg);

  await pool.query(`
    UPDATE activity SET messages = messages + 1, message_score = message_score + $3, last_seen = NOW()
    WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId, pts]);

  // Saat bazlı istatistik
  const hour = new Date().getUTCHours();
  await pool.query(`
    INSERT INTO activity_hours (guild_id, user_id, hour, count) VALUES ($1, $2, $3, 1)
    ON CONFLICT (guild_id, user_id, hour) DO UPDATE SET count = activity_hours.count + 1
  `, [guildId, userId, hour]);

  // Kanal bazlı istatistik
  await pool.query(`
    INSERT INTO channel_stats (guild_id, user_id, channel_id, channel_name, count) VALUES ($1, $2, $3, $4, 1)
    ON CONFLICT (guild_id, user_id, channel_id) DO UPDATE SET count = channel_stats.count + 1, channel_name = $4
  `, [guildId, userId, channelId, channelName]);

  return pts;
}

async function logMessage({ guildId, userId, username, channelId, channelName, content, replyToUserId, replyToUsername, replyToContent, score = 0 }) {
  await pool.query(`
    INSERT INTO message_logs (guild_id, user_id, username, channel_id, channel_name, content, reply_to_user_id, reply_to_username, reply_to_content, score)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [guildId, userId, username, channelId, channelName, content, replyToUserId ?? null, replyToUsername ?? null, replyToContent ?? null, score]);
}

async function voiceJoin(guildId, userId, username, channelId, channelName, micOn = false) {
  await ensureUser(guildId, userId, username);
  await pool.query(`
    UPDATE activity
    SET voice_joined_at = $3, voice_channel_id = $4, voice_channel_name = $5,
        voice_mic_on_at = $6, voice_active_seconds = 0, last_seen = NOW()
    WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId, Date.now(), channelId ?? null, channelName ?? null, micOn ? Date.now() : null]);
}

async function voiceMicOn(guildId, userId) {
  await pool.query(
    `UPDATE activity SET voice_mic_on_at = $3 WHERE guild_id = $1 AND user_id = $2 AND voice_joined_at IS NOT NULL`,
    [guildId, userId, Date.now()]
  );
}

async function voiceMicOff(guildId, userId) {
  const res = await pool.query(
    `SELECT voice_mic_on_at FROM activity WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );
  const micOnAt = res.rows[0]?.voice_mic_on_at;
  if (!micOnAt) return;
  const elapsed = Math.floor((Date.now() - parseInt(micOnAt)) / 1000);
  await pool.query(
    `UPDATE activity SET voice_mic_on_at = NULL, voice_active_seconds = voice_active_seconds + $3 WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, elapsed]
  );
}

async function voiceLeave(guildId, userId) {
  try {
    const res = await pool.query(
      `SELECT username, voice_joined_at, voice_channel_id, voice_channel_name, voice_mic_on_at, voice_active_seconds FROM activity WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
    const row = res.rows[0];
    if (!row?.voice_joined_at) return;

    const joinedAt = parseInt(row.voice_joined_at);
    const leftAt = Date.now();
    const seconds = Math.floor((leftAt - joinedAt) / 1000);

    // Mic-on süresi: birikmiş + şu an açıksa şimdiye kadar geçen süre
    const micOnAt = row.voice_mic_on_at ? parseInt(row.voice_mic_on_at) : null;
    const activeSeconds = parseInt(row.voice_active_seconds ?? 0)
      + (micOnAt ? Math.floor((leftAt - micOnAt) / 1000) : 0);

    const cfg = await getScoreConfig(guildId);
    const voiceScore = Math.round((activeSeconds / 60) * cfg.voice_per_min * 100) / 100;

    await pool.query(`
      UPDATE activity
      SET voice_seconds = voice_seconds + $3, voice_score = voice_score + $4,
          voice_joined_at = NULL, voice_mic_on_at = NULL, voice_active_seconds = 0,
          voice_channel_id = NULL, voice_channel_name = NULL, last_seen = NOW()
      WHERE guild_id = $1 AND user_id = $2
    `, [guildId, userId, seconds, voiceScore]);

    await pool.query(`
      INSERT INTO voice_logs (guild_id, user_id, username, channel_id, channel_name, joined_at, left_at, duration_seconds, active_seconds)
      VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), $8, $9)
    `, [guildId, userId, row.username, row.voice_channel_id ?? 'bilinmiyor', row.voice_channel_name ?? 'bilinmiyor', joinedAt, leftAt, seconds, activeSeconds]);

    console.log(`🔇 ${row.username} → ${seconds}sn ses logu kaydedildi.`);
  } catch (err) {
    console.error(`[voiceLeave] HATA:`, err.message);
  }
}

async function logMod({ guildId, actionType, targetUserId, targetUsername, executorUserId, executorUsername, reason, durationSeconds }) {
  await pool.query(`
    INSERT INTO mod_logs (guild_id, action_type, target_user_id, target_username, executor_user_id, executor_username, reason, duration_seconds)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [guildId, actionType, targetUserId, targetUsername, executorUserId ?? null, executorUsername ?? null, reason ?? null, durationSeconds ?? null]);
}

async function getAll(guildId) {
  const res = await pool.query(`SELECT * FROM activity WHERE guild_id = $1 ORDER BY messages DESC`, [guildId]);
  return res.rows;
}

async function getUser(guildId, userId) {
  const res = await pool.query(`SELECT * FROM activity WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
  return res.rows[0] ?? null;
}

async function getUserMessages(guildId, userId, limit = 20, channelId = null) {
  if (channelId) {
    const res = await pool.query(
      `SELECT * FROM message_logs WHERE guild_id = $1 AND user_id = $2 AND channel_id = $3 ORDER BY created_at DESC LIMIT $4`,
      [guildId, userId, channelId, limit]
    );
    return res.rows;
  }
  const res = await pool.query(
    `SELECT * FROM message_logs WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [guildId, userId, limit]
  );
  return res.rows;
}

async function getUserVoiceLogs(guildId, userId, limit = 10) {
  const res = await pool.query(
    `SELECT * FROM voice_logs WHERE guild_id = $1 AND user_id = $2 ORDER BY left_at DESC LIMIT $3`,
    [guildId, userId, limit]
  );
  return res.rows;
}

async function getUserVoiceStats(guildId, userId) {
  const res = await pool.query(`
    SELECT
      COUNT(*)                                        AS total_sessions,
      COALESCE(SUM(duration_seconds), 0)             AS total_seconds,
      COALESCE(SUM(active_seconds), 0)               AS total_active_seconds,
      COALESCE(AVG(duration_seconds), 0)             AS avg_seconds,
      COALESCE(MAX(duration_seconds), 0)             AS longest_seconds,
      (
        SELECT channel_name FROM voice_logs
        WHERE guild_id = $1 AND user_id = $2
        GROUP BY channel_name
        ORDER BY SUM(duration_seconds) DESC
        LIMIT 1
      )                                              AS top_channel
    FROM voice_logs WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId]);
  return res.rows[0];
}

async function getUserModLogs(guildId, userId, limit = 10) {
  const res = await pool.query(
    `SELECT * FROM mod_logs WHERE guild_id = $1 AND target_user_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [guildId, userId, limit]
  );
  return res.rows;
}

async function getTopChannel(guildId, userId) {
  const res = await pool.query(
    `SELECT channel_name, count FROM channel_stats WHERE guild_id = $1 AND user_id = $2 ORDER BY count DESC LIMIT 1`,
    [guildId, userId]
  );
  return res.rows[0] ?? null;
}

async function getPeakHour(guildId, userId) {
  const res = await pool.query(
    `SELECT hour, count FROM activity_hours WHERE guild_id = $1 AND user_id = $2 ORDER BY count DESC LIMIT 1`,
    [guildId, userId]
  );
  return res.rows[0] ?? null;
}

async function getInactiveStaff(guildId, days = 3) {
  const res = await pool.query(
    `SELECT * FROM activity WHERE guild_id = $1 AND (last_seen < NOW() - INTERVAL '1 day' * $2 OR last_seen IS NULL)`,
    [guildId, days]
  );
  return res.rows;
}

async function getRecentModLogs(guildId, limit = 20) {
  const res = await pool.query(
    `SELECT * FROM mod_logs WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [guildId, limit]
  );
  return res.rows;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}s ${m}dk`;
  if (m > 0) return `${m}dk ${s}sn`;
  return `${s}sn`;
}

// ── XP Log ───────────────────────────────────────────────────
// Mesaj/ses puanları burada loglanmaz (çok sık) — sadece anlamlı olaylar loglanır
async function logXP(guildId, userId, username, type, amount, reason = null) {
  try {
    await pool.query(
      `INSERT INTO xp_log (guild_id, user_id, username, type, amount, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [guildId, userId, username, type, amount, reason]
    );
  } catch (err) {
    // xp_log tablosu henüz oluşturulmamışsa sessizce geç
    if (err.code !== '42P01') console.error('[logXP]', err.message);
  }
}

async function getXpLog(guildId, userId, limit = 20) {
  try {
    const res = await pool.query(
      `SELECT * FROM xp_log WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [guildId, userId, limit]
    );
    return res.rows;
  } catch { return []; }
}

async function addTaskPoints(guildId, userId, username, points, reason = null) {
  await ensureUser(guildId, userId, username);
  await pool.query(
    `UPDATE activity SET task_points = task_points + $3 WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, points]
  );
  await logXP(guildId, userId, username, 'task', points, reason);
}

async function addMandatoryTaskPoints(guildId, userId, username, points, reason = null) {
  await ensureUser(guildId, userId, username);
  await pool.query(
    `UPDATE activity SET mandatory_task_points = mandatory_task_points + $3 WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, points]
  );
  await logXP(guildId, userId, username, 'mandatory_task', points, reason);
}

async function addResponsibilityPoints(guildId, userId, username, points, reason = null) {
  await ensureUser(guildId, userId, username);
  await pool.query(
    `UPDATE activity SET responsibility_points = responsibility_points + $3 WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, points]
  );
  await logXP(guildId, userId, username, 'responsibility', points, reason);
}

async function addManualPoints(guildId, userId, username, points, reason, givenById, givenBy) {
  await ensureUser(guildId, userId, username);
  // Bug fix: manual_points 0'ın altına düşmesin
  await pool.query(
    `UPDATE activity SET manual_points = GREATEST(manual_points + $3, 0) WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, points]
  );
  await pool.query(
    `INSERT INTO manual_point_logs (guild_id, user_id, username, points, reason, given_by_id, given_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [guildId, userId, username, points, reason ?? null, givenById, givenBy]
  );
  await logXP(guildId, userId, username, 'manual', points, reason ?? `${givenBy} tarafından`);
}

async function getManualPointLogs(guildId, userId, limit = 10) {
  const res = await pool.query(
    `SELECT * FROM manual_point_logs WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [guildId, userId, limit]
  );
  return res.rows;
}

function activityScore(user) {
  const total = parseFloat(user.message_score       ?? 0)
    + parseFloat(user.voice_score                   ?? 0)
    + parseFloat(user.task_points                   ?? 0)
    + parseFloat(user.mandatory_task_points         ?? 0)
    + parseFloat(user.responsibility_points         ?? 0)  // Bug fix: terfi hesabına dahil edilmemişti
    + parseFloat(user.manual_points                 ?? 0);
  return Math.round(total * 100) / 100;
}

async function logPointsToChannel(client, guildId, { userId, username, points, source, detail = null }) {
  try {
    const res = await pool.query(`SELECT value FROM guild_config WHERE guild_id = $1 AND key = 'points_log_channel'`, [guildId]);
    const channelId = res.rows[0]?.value;
    if (!channelId) return;

    const channel = client.channels.cache.get(channelId);
    if (!channel) return;

    const sourceLabel = source === 'task' ? '📌 Görev'
      : source === 'mesaj' ? '💬 Mesaj'
      : source === 'sorumluluk' ? '🎯 Sorumluluk'
      : source === 'ses' ? '🎙️ Ses'
      : '⭐ Manuel';
    const color = source === 'task' ? 0x9966ff
      : source === 'mesaj' ? 0x5865f2
      : source === 'sorumluluk' ? 0x43b581
      : source === 'ses' ? 0x7289da
      : 0xffcc00;

    const sign = points >= 0 ? `+${points}` : `${points}`;
    const embed = new EmbedBuilder()
      .setColor(points >= 0 ? color : 0xff6b6b)
      .setTitle(`${sign} Puan ${points >= 0 ? 'Eklendi' : 'Çıkarıldı'}`)
      .addFields(
        { name: '👤 Kullanıcı', value: `<@${userId}> (${username})`, inline: true },
        { name: '🏆 Puan', value: `**${sign}**`, inline: true },
        { name: '📂 Kaynak', value: sourceLabel, inline: true },
      )
      .setTimestamp();

    if (detail) embed.addFields({ name: '📝 Detay', value: detail, inline: false });

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[logPointsToChannel]', err.message);
  }
}

const { init } = require('./database');
module.exports = {
  init, addMessage, logMessage, voiceJoin, voiceLeave, voiceMicOn, voiceMicOff, logMod,
  addTaskPoints, addMandatoryTaskPoints, addManualPoints, addResponsibilityPoints, getManualPointLogs,
  logXP, getXpLog,
  getScoreConfig, calcMessageScore,
  getAll, getUser, getUserMessages, getUserVoiceLogs, getUserVoiceStats, getUserModLogs,
  getTopChannel, getPeakHour, getInactiveStaff, getRecentModLogs,
  formatTime, activityScore, logPointsToChannel,
};

const { pool } = require('./database');

const TTL = 60_000;
const cache = new Map(); // guildId → { channels: Set<channelId>, lastLoaded: number }

async function loadFromDB(guildId) {
  const res = await pool.query(`SELECT channel_id FROM blocked_log_channels WHERE guild_id = $1`, [guildId]);
  cache.set(guildId, { channels: new Set(res.rows.map(r => r.channel_id)), lastLoaded: Date.now() });
}

async function isBlocked(guildId, channelId) {
  const entry = cache.get(guildId);
  if (!entry || Date.now() - entry.lastLoaded > TTL) await loadFromDB(guildId);
  return cache.get(guildId)?.channels.has(channelId) ?? false;
}

async function blockChannel(guildId, channelId, channelName, addedBy) {
  await pool.query(
    `INSERT INTO blocked_log_channels (guild_id, channel_id, channel_name, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, channel_id) DO UPDATE SET channel_name = $3`,
    [guildId, channelId, channelName, addedBy]
  );
  const entry = cache.get(guildId);
  if (entry) entry.channels.add(channelId);
}

async function unblockChannel(guildId, channelId) {
  await pool.query(`DELETE FROM blocked_log_channels WHERE guild_id = $1 AND channel_id = $2`, [guildId, channelId]);
  cache.get(guildId)?.channels.delete(channelId);
}

async function getBlockedChannels(guildId) {
  const res = await pool.query(`SELECT * FROM blocked_log_channels WHERE guild_id = $1 ORDER BY added_at DESC`, [guildId]);
  return res.rows;
}

module.exports = { isBlocked, blockChannel, unblockChannel, getBlockedChannels, loadFromDB };

const { EmbedBuilder } = require('discord.js');
const { pool } = require('./database');
const { formatTime } = require('./activityTracker');

// ── Yardımcılar ───────────────────────────────────────────────

async function getCurrentSeason(guildId) {
  const res = await pool.query(
    `SELECT * FROM seasons WHERE guild_id = $1 AND is_active = TRUE ORDER BY started_at DESC LIMIT 1`,
    [guildId]
  );
  return res.rows[0] ?? null;
}

async function listSeasons(guildId) {
  const res = await pool.query(
    `SELECT * FROM seasons WHERE guild_id = $1 ORDER BY started_at DESC LIMIT 20`,
    [guildId]
  );
  return res.rows;
}

async function getSeasonLeaderboard(seasonId, guildId) {
  const res = await pool.query(`
    SELECT * FROM season_snapshots
    WHERE season_id = $1 AND guild_id = $2
    ORDER BY total_score DESC
    LIMIT 10
  `, [seasonId, guildId]);
  return res.rows;
}

// ── Sezon başlat ─────────────────────────────────────────────

async function startSeason(guildId, name) {
  const current = await getCurrentSeason(guildId);
  if (current) throw new Error(`**${current.name}** adında aktif bir sezon zaten var. Önce \`/season bitir\` ile mevcut sezonu kapat.`);

  const res = await pool.query(
    `INSERT INTO seasons (guild_id, name) VALUES ($1, $2) RETURNING *`,
    [guildId, name]
  );
  return res.rows[0];
}

// ── Sezon bitir ───────────────────────────────────────────────
// Döndürür: { season, topRows }

async function endSeason(guildId) {
  const current = await getCurrentSeason(guildId);
  if (!current) throw new Error('Aktif bir sezon bulunamadı. Önce `/season baslat` ile yeni sezon başlat.');

  // 1. Anlık skorları arşive yaz
  await pool.query(`
    INSERT INTO season_snapshots
      (season_id, guild_id, user_id, username,
       messages, voice_seconds,
       message_score, voice_score, task_points,
       mandatory_task_points, responsibility_points, manual_points,
       total_score)
    SELECT
      $1, guild_id, user_id, username,
      COALESCE(messages, 0), COALESCE(voice_seconds, 0),
      COALESCE(message_score, 0), COALESCE(voice_score, 0), COALESCE(task_points, 0),
      COALESCE(mandatory_task_points, 0), COALESCE(responsibility_points, 0), COALESCE(manual_points, 0),
      COALESCE(message_score,0) + COALESCE(voice_score,0) + COALESCE(task_points,0) +
      COALESCE(mandatory_task_points,0) + COALESCE(responsibility_points,0) + COALESCE(manual_points,0)
    FROM activity
    WHERE guild_id = $2
  `, [current.id, guildId]);

  // 2. Sıra numaralarını güncelle
  await pool.query(`
    UPDATE season_snapshots
    SET final_rank = sub.rn
    FROM (
      SELECT id,
        ROW_NUMBER() OVER (PARTITION BY season_id ORDER BY total_score DESC) AS rn
      FROM season_snapshots
      WHERE season_id = $1
    ) sub
    WHERE season_snapshots.id = sub.id
  `, [current.id]);

  // 3. Sezonu kapat
  await pool.query(
    `UPDATE seasons SET is_active = FALSE, ended_at = NOW() WHERE id = $1`,
    [current.id]
  );

  // 4. Puanları sıfırla (streak ve roller dokunulmaz)
  await pool.query(`
    UPDATE activity
    SET messages = 0, voice_seconds = 0,
        message_score = 0, voice_score = 0, task_points = 0,
        mandatory_task_points = 0, responsibility_points = 0, manual_points = 0
    WHERE guild_id = $1
  `, [guildId]);

  // 5. Haftalık görev/sorumluluk kayıtlarını sıfırla
  //    rs_completions toplam sorgularında hafta filtresi olmadığından
  //    eski sezon verileri yeni sezonda birikir — temizle
  await pool.query(`DELETE FROM rs_completions WHERE guild_id = $1`, [guildId]);
  await pool.query(`DELETE FROM rs_mandatory    WHERE guild_id = $1`, [guildId]);

  // 5. Arşivden top 10'u çek (embed için)
  const topRows = await getSeasonLeaderboard(current.id, guildId);

  return { season: current, topRows };
}

// ── Sezon sonu embed ─────────────────────────────────────────

function buildSeasonEndEmbed(season, topRows) {
  const medals = ['🥇', '🥈', '🥉'];
  const started = Math.floor(new Date(season.started_at).getTime() / 1000);

  const lines = topRows.length
    ? topRows.map((r, i) =>
        `${medals[i] ?? `**${i + 1}.**`} **${r.username}** — ⭐ ${parseFloat(r.total_score).toFixed(1)} XP`
      ).join('\n')
    : '*Bu sezon veri yok.*';

  return new EmbedBuilder()
    .setTitle(`🏁 ${season.name} — Sezon Sona Erdi`)
    .setColor(0xffcc00)
    .setDescription(lines)
    .addFields(
      { name: '📅 Başlangıç', value: `<t:${started}:D>`, inline: true },
      { name: '📅 Bitiş',     value: `<t:${Math.floor(Date.now() / 1000)}:D>`, inline: true },
    )
    .setFooter({ text: 'Puanlar sıfırlandı • Yeni sezon başlayabilir' })
    .setTimestamp();
}

function buildSeasonArchiveEmbed(season, topRows) {
  const medals = ['🥇', '🥈', '🥉'];
  const started = Math.floor(new Date(season.started_at).getTime() / 1000);
  const ended   = season.ended_at ? Math.floor(new Date(season.ended_at).getTime() / 1000) : null;

  const lines = topRows.length
    ? topRows.map((r, i) =>
        `${medals[i] ?? `**${i + 1}.**`} **${r.username}** — ⭐ ${parseFloat(r.total_score).toFixed(1)} XP`
      ).join('\n')
    : '*Bu sezon veri yok.*';

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${season.name} — Arşiv`)
    .setColor(0x7289da)
    .setDescription(lines)
    .addFields(
      { name: '📅 Başlangıç', value: `<t:${started}:D>`, inline: true },
      { name: '📅 Bitiş',     value: ended ? `<t:${ended}:D>` : 'Aktif', inline: true },
      { name: '👥 Katılımcı', value: `${topRows.length}+ kişi`, inline: true },
    )
    .setTimestamp();

  return embed;
}

module.exports = {
  getCurrentSeason,
  listSeasons,
  getSeasonLeaderboard,
  startSeason,
  endSeason,
  buildSeasonEndEmbed,
  buildSeasonArchiveEmbed,
};

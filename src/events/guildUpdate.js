const { EmbedBuilder, AuditLogEvent, Routes } = require('discord.js');
const { pool } = require('../utils/database');

async function getCfg(guildId, key) {
  const res = await pool.query(
    `SELECT value FROM guild_config WHERE guild_id = $1 AND key = $2`,
    [guildId, key]
  );
  return res.rows[0]?.value ?? null;
}

module.exports = {
  name: 'guildUpdate',
  async execute(oldGuild, newGuild) {
    if (oldGuild.vanityURLCode === newGuild.vanityURLCode) return;

    const guildId       = newGuild.id;
    const protectedCode = await getCfg(guildId, 'guard_vanity_code');
    if (!protectedCode) return;

    if (newGuild.vanityURLCode === protectedCode) return;

    console.log(`[Guard] ⚠️ Vanity değişti: ${oldGuild.vanityURLCode} → ${newGuild.vanityURLCode ?? 'silindi'}`);

    // ── Revert dene ───────────────────────────────────────────
    let reverted = false;
    try {
      await newGuild.client.rest.patch(Routes.guild(newGuild.id), {
        body: { vanity_url_code: protectedCode },
      });
      await new Promise(r => setTimeout(r, 1500));
      const fresh = await newGuild.fetch();
      reverted = fresh.vanityURLCode === protectedCode;
      console.log(`[Guard] Revert sonucu: ${fresh.vanityURLCode} → ${reverted ? '✅' : '❌'}`);
    } catch (err) {
      console.error(`[Guard] Revert hatası:`, err.message);
    }

    // ── Kim değiştirdi? (Audit Log) ──────────────────────────
    let changedBy = null;
    let member    = null;
    try {
      const logs = await newGuild.fetchAuditLogs({ type: AuditLogEvent.GuildUpdate, limit: 1 });
      const entry = logs.entries.first();
      if (entry && Date.now() - entry.createdTimestamp < 5000) {
        changedBy = entry.executor;
        member    = await newGuild.members.fetch(changedBy.id).catch(() => null);
      }
    } catch {}

    // ── Ban + rol sıfırla ─────────────────────────────────────
    let banned   = false;
    let banError = null;

    if (member) {
      const botMember = await newGuild.members.fetchMe().catch(() => null);
      const botPos    = botMember?.roles.highest.position ?? 0;
      const canBan    = botPos > member.roles.highest.position;

      if (canBan) {
        try {
          await newGuild.members.ban(changedBy.id, { reason: 'Vanity URL Guard — Otomatik Ban' });
          banned = true;
          console.log(`[Guard] 🔨 ${changedBy.username} banlandı`);
        } catch (err) {
          banError = err.message;
          console.error(`[Guard] Ban hatası:`, err.message);
        }
      } else {
        banError = `Botun rolü kullanıcının altında, ban yapılamadı.`;
        console.error(`[Guard] ❌ ${banError}`);
      }
    }

    // ── Log kanalına bildir ──────────────────────────────────
    const logChannelId = await getCfg(guildId, 'guard_log_channel');
    if (!logChannelId) return;

    const logChannel = newGuild.client.channels.cache.get(logChannelId);
    if (!logChannel) return;

    const actionStr = [
      reverted ? '✅ URL geri döndürüldü' : `❌ URL döndürülemedi → \`${protectedCode}\` elle yaz`,
      banned   ? '✅ Kullanıcı banlandı'  : `❌ Ban yapılamadı${banError ? `: ${banError}` : ''}`,
    ].join('\n');

    const embed = new EmbedBuilder()
      .setColor(banned ? 0xff4444 : 0xff9900)
      .setTitle('🛡️ Vanity URL Guard Devreye Girdi')
      .addFields(
        { name: '✅ Olması Gereken', value: `discord.gg/**${protectedCode}**`,                        inline: true  },
        { name: '❌ Değiştirilen',   value: `discord.gg/**${newGuild.vanityURLCode ?? 'silindi'}**`,  inline: true  },
        { name: '👤 Değiştiren',     value: changedBy ? `<@${changedBy.id}> (${changedBy.username})` : '*Bilinmiyor*', inline: false },
        { name: '⚡ Yapılan İşlemler', value: actionStr,                                              inline: false },
      )
      .setTimestamp();

    await logChannel.send({ content: '@here', embeds: [embed] }).catch(() => {});
  },
};

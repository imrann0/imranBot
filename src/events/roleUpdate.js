const { EmbedBuilder, PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const { pool } = require('../utils/database');

async function getCfg(guildId, key) {
  const res = await pool.query(
    `SELECT value FROM guild_config WHERE guild_id = $1 AND key = $2`,
    [guildId, key]
  );
  return res.rows[0]?.value ?? null;
}

module.exports = {
  name: 'roleUpdate',
  async execute(oldRole, newRole) {
    const guildId = newRole.guild.id;

    // Rol koruma aktif mi?
    const enabled = await getCfg(guildId, 'guard_role_enabled');
    if (enabled !== 'true') return;

    const hadAdmin   = oldRole.permissions.has(PermissionFlagsBits.Administrator);
    const hasAdmin   = newRole.permissions.has(PermissionFlagsBits.Administrator);
    const hadManage  = oldRole.permissions.has(PermissionFlagsBits.ManageGuild);
    const hasManage  = newRole.permissions.has(PermissionFlagsBits.ManageGuild);

    // Yönetici veya Sunucuyu Yönet yetkisi yeni eklendiyse
    const triggerAdmin  = !hadAdmin  && hasAdmin;
    const triggerManage = !hadManage && hasManage;
    if (!triggerAdmin && !triggerManage) return;

    const yetkiAdi = triggerAdmin ? 'Yönetici' : 'Sunucuyu Yönet';
    console.log(`[Guard] ⚠️ "${newRole.name}" rolüne ${yetkiAdi} yetkisi verildi`);

    // ── Kim verdi? (Audit Log) ────────────────────────────────
    let executor = null;
    let member   = null;
    try {
      await new Promise(r => setTimeout(r, 500));
      const logs = await newRole.guild.fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 5 });
      const entry = logs.entries.find(e =>
        e.target?.id === newRole.id &&
        Date.now() - e.createdTimestamp < 5000
      );
      if (entry) {
        executor = entry.executor;
        member   = await newRole.guild.members.fetch(executor.id).catch(() => null);
      }
    } catch (err) {
      console.error(`[Guard] Audit log hatası:`, err.message);
    }

    // ── Veren kişiyi ban at ───────────────────────────────────
    let banned   = false;
    let banError = null;

    if (member) {
      const botMember = await newRole.guild.members.fetchMe().catch(() => null);
      const botPos    = botMember?.roles.highest.position ?? 0;
      const canBan    = botPos > member.roles.highest.position;

      if (canBan) {
        try {
          await newRole.guild.members.ban(executor.id, {
            reason: `Vanity URL Guard — ${yetkiAdi} yetkisi verdi`,
          });
          banned = true;
          console.log(`[Guard] 🔨 ${executor.username} banlandı (${yetkiAdi} yetkisi verdi)`);
        } catch (err) {
          banError = err.message;
          console.error(`[Guard] Ban hatası:`, err.message);
        }
      } else {
        banError = 'Botun rolü kullanıcının altında.';
      }
    } else {
      banError = 'Kim verdiği tespit edilemedi.';
    }

    // ── Log kanalına bildir ───────────────────────────────────
    const logChannelId = await getCfg(guildId, 'guard_role_log_channel');
    if (!logChannelId) return;
    const logChannel = newRole.guild.client.channels.cache.get(logChannelId);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
      .setColor(banned ? 0xff4444 : 0xff9900)
      .setTitle('🛡️ Yetkisiz İzin Değişikliği Tespit Edildi')
      .addFields(
        { name: '🎭 Etkilenen Rol', value: `<@&${newRole.id}> (${newRole.name})`,                              inline: true  },
        { name: '⚠️ Verilen Yetki', value: yetkiAdi,                                                           inline: true  },
        { name: '👤 Veren Kişi',    value: executor ? `<@${executor.id}> (${executor.username})` : '*Bilinmiyor*', inline: false },
        { name: '⚡ Sonuç',         value: banned
            ? '✅ Kullanıcı banlandı.'
            : `❌ Ban yapılamadı: ${banError}`,
          inline: false },
      )
      .setTimestamp();

    await logChannel.send({ content: '@here', embeds: [embed] }).catch(() => {});
  },
};

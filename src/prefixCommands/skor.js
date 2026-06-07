const { EmbedBuilder } = require('discord.js');
const { getUser, activityScore, formatTime } = require('../utils/activityTracker');
const { getRoles, getUser: getRsUser } = require('../utils/roleSystem');
const { pool } = require('../utils/database');
const { getCurrentSeason } = require('../utils/seasonManager');

module.exports = {
  name: 'skor',
  aliases: ['profil', 'stats', 'istatistik', 'xp'],
  cooldown: 10,
  description: 'Kendi aktivite ve skor istatistiklerini gösterir',
  async execute(message, args) {
    const guildId = message.guild.id;

    // @mention veya kendisi
    const mentioned = message.mentions.users.first();
    const target    = mentioned ?? message.author;

    const act = await getUser(guildId, target.id);
    if (!act) {
      return message.reply(`❌ **${target.username}** için kayıt bulunamadı. Henüz aktivite yok.`);
    }

    const totalXP     = activityScore(act);
    const msgPoints   = parseFloat(act.message_score         ?? 0).toFixed(1);
    const voicePoints = parseFloat(act.voice_score           ?? 0).toFixed(1);
    const mandPts     = parseFloat(act.mandatory_task_points ?? 0).toFixed(1);
    const taskPts     = parseFloat(act.task_points           ?? 0).toFixed(1);
    const respPts     = parseFloat(act.responsibility_points ?? 0).toFixed(1);
    const manualPts   = parseFloat(act.manual_points         ?? 0).toFixed(1);

    // Görev istatistikleri
    const taskStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE ta.status = 'tamamlandı') AS completed,
        COUNT(*) FILTER (WHERE ta.status IN ('bekliyor','onay_bekleniyor')) AS pending,
        COUNT(*) FILTER (WHERE ta.completed_at >= NOW() - INTERVAL '7 days' AND ta.status = 'tamamlandı') AS completed_7d
      FROM task_assignments ta
      JOIN tasks t ON t.id = ta.task_id
      WHERE t.guild_id = $1 AND ta.user_id = $2 AND t.status != 'iptal'
    `, [guildId, target.id]).then(r => r.rows[0]).catch(() => ({ completed: 0, pending: 0, completed_7d: 0 }));

    // Bu hafta zorunlu tamamlandı mı?
    const d = new Date();
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    const year = d.getUTCFullYear();

    const mandRow  = await pool.query(
      `SELECT completed FROM rs_mandatory WHERE guild_id = $1 AND user_id = $2 AND week_number = $3 AND year = $4`,
      [guildId, target.id, week, year]
    ).then(r => r.rows[0]).catch(() => null);
    const mandDone = mandRow?.completed ?? false;

    // Streak ve uyarı
    const rsUser = await getRsUser(guildId, target.id).catch(() => null);
    const streak   = rsUser?.streak ?? 0;
    const warnings = rsUser?.warning_count ?? 0;

    // Rol hiyerarşisi (mevcut rol + sonraki rol)
    let currentRole = null;
    let nextRole    = null;
    let xpToNext    = null;
    try {
      const member = await message.guild.members.fetch(target.id);
      const roles  = await getRoles(guildId);
      for (const r of [...roles].reverse()) {
        if (member.roles.cache.has(r.role_id)) { currentRole = r; break; }
      }
      if (currentRole) {
        nextRole = roles.find(r => r.position === currentRole.position + 1) ?? null;
      } else if (roles.length) {
        nextRole = roles[0];
      }
      if (nextRole) xpToNext = Math.max(0, nextRole.xp_required - totalXP);
    } catch {}

    const currentSeason = await getCurrentSeason(guildId);
    const seasonFooter  = currentSeason ? `📅 ${currentSeason.name}` : 'Aktif sezon yok';

    const embed = new EmbedBuilder()
      .setColor(0x9966ff)
      .setTitle(`📊 ${target.username} — Skor`)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .setDescription([
        `⭐ **Toplam Skor: ${totalXP} puan**`,
        '',
        `💬 Mesaj: **${msgPoints}p**  •  🎙️ Ses: **${voicePoints}p**`,
        `⚠️ Zorunlu: **${mandPts}p**  •  🎯 İsteğe Bağlı: **${taskPts}p**`,
        `📌 Sorumluluk: **${respPts}p**  •  ✨ Manuel: **${manualPts}p**`,
      ].join('\n'))
      .addFields(
        { name: '💬 Mesaj Sayısı',      value: `${act.messages ?? 0}`,                           inline: true },
        { name: '🎙️ Toplam Ses',        value: formatTime(Number(act.voice_seconds ?? 0)),        inline: true },
        { name: '📅 Bu Hafta Zorunlu',  value: mandDone ? '✅ Tamamlandı' : '❌ Tamamlanmadı',    inline: true },
        { name: '🔥 Streak',            value: `${streak} hafta`,                                 inline: true },
        { name: '⚠️ Uyarı',            value: `${warnings}`,                                     inline: true },
        { name: '✅ Tamamlanan Görev',  value: `${taskStats.completed}`,                          inline: true },
        { name: '🎭 Mevcut Rol',        value: currentRole ? `<@&${currentRole.role_id}>` : '*Yok*', inline: true },
        { name: '🎯 Sonraki Rol',       value: nextRole
            ? `<@&${nextRole.role_id}> · **${xpToNext}p** kaldı`
            : '*En üst roldeysin*',                                                                inline: true },
        { name: '⏳ Bekleyen Görev',    value: `${taskStats.pending}`,                            inline: true },
      )
      .setFooter({ text: seasonFooter })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
};

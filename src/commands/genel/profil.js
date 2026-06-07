const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getUser, activityScore, getXpLog, formatTime } = require('../../utils/activityTracker');
const { getRoles, getUser: getRsUser } = require('../../utils/roleSystem');
const { pool } = require('../../utils/database');
const { getCurrentSeason } = require('../../utils/seasonManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profil')
    .setDescription('XP özeti, streak ve görev istatistiklerini gösterir')
    .addUserOption(opt =>
      opt.setName('kullanici').setDescription('Başka bir kullanıcının profili').setRequired(false)
    ),
  category: 'genel',

  async execute(interaction) {
    const target = interaction.options.getUser('kullanici') ?? interaction.user;
    const guildId = interaction.guild.id;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Activity tablosu
    const act = await getUser(guildId, target.id);
    if (!act) {
      return interaction.editReply({ content: `❌ **${target.username}** için kayıt bulunamadı.` });
    }

    const totalXP = activityScore(act);

    // RS kullanıcı (streak, haftalık)
    const rsUser = await getRsUser(guildId, target.id).catch(() => null);

    // Mevcut rol
    let currentRole = null;
    let nextRole    = null;
    try {
      const member = await interaction.guild.members.fetch(target.id);
      const roles  = await getRoles(guildId);
      // En yüksek sahip olunan sistem rolü
      for (const r of [...roles].reverse()) {
        if (member.roles.cache.has(r.role_id)) { currentRole = r; break; }
      }
      // Sonraki rol
      if (currentRole) {
        nextRole = roles.find(r => r.position === currentRole.position + 1) ?? null;
      } else if (roles.length) {
        nextRole = roles[0];
      }
    } catch {}

    // Görev istatistikleri (genel + son 7 gün)
    const taskStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE ta.status = 'tamamlandı') AS completed,
        COUNT(*) FILTER (WHERE ta.status IN ('bekliyor','onay_bekleniyor')) AS pending,
        COUNT(*) FILTER (WHERE t.is_mandatory IS TRUE AND ta.status = 'tamamlandı') AS mandatory_done,
        COUNT(*) FILTER (WHERE ta.completed_at >= NOW() - INTERVAL '7 days' AND ta.status = 'tamamlandı') AS completed_7d,
        COUNT(*) FILTER (WHERE ta.assigned_at  >= NOW() - INTERVAL '7 days') AS assigned_7d
      FROM task_assignments ta
      JOIN tasks t ON t.id = ta.task_id
      WHERE t.guild_id = $1 AND ta.user_id = $2 AND t.status != 'iptal'
    `, [guildId, target.id]).then(r => r.rows[0]).catch(() => ({ completed: 0, pending: 0, mandatory_done: 0, completed_7d: 0, assigned_7d: 0 }));

    // Bu haftalık zorunlu tamamlandı mı?
    const { week, year } = (() => {
      const d = new Date();
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const w = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
      return { week: w, year: d.getUTCFullYear() };
    })();
    const mandRow = await pool.query(
      `SELECT completed FROM rs_mandatory WHERE guild_id = $1 AND user_id = $2 AND week_number = $3 AND year = $4`,
      [guildId, target.id, week, year]
    ).then(r => r.rows[0]).catch(() => null);
    const mandDone = mandRow?.completed ?? false;

    // Son XP log (son 5)
    const xpLogs = await getXpLog(guildId, target.id, 5);
    const currentSeason = await getCurrentSeason(guildId);

    // Embed oluştur
    const typeLabel = { task: '📌 Görev', mandatory_task: '⚠️ Zorunlu', responsibility: '🎯 Sorumluluk', manual: '⭐ Manuel' };
    const streak = rsUser?.streak ?? 0;

    const seasonFooter = currentSeason ? `📅 ${currentSeason.name}` : '';

    const embed = new EmbedBuilder()
      .setColor(0x9966ff)
      .setTitle(`👤 ${target.username} — Profil`)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .addFields(
        // XP özeti
        { name: '🏆 Toplam XP', value: `**${totalXP}**`, inline: true },
        { name: '🔥 Streak', value: `**${streak}** hafta`, inline: true },
        { name: '📅 Bu Hafta Zorunlu', value: mandDone ? '✅ Tamamlandı' : '❌ Tamamlanmadı', inline: true },

        // XP breakdown
        { name: '📊 XP Dağılımı', value: [
          `💬 Mesaj: **${parseFloat(act.message_score ?? 0).toFixed(1)}**`,
          `🎙️ Ses: **${parseFloat(act.voice_score ?? 0).toFixed(1)}**`,
          `📌 Görev: **${parseFloat(act.task_points ?? 0).toFixed(1)}**`,
          `⚠️ Zorunlu: **${parseFloat(act.mandatory_task_points ?? 0).toFixed(1)}**`,
          `🎯 Sorumluluk: **${parseFloat(act.responsibility_points ?? 0).toFixed(1)}**`,
          `⭐ Manuel: **${parseFloat(act.manual_points ?? 0).toFixed(1)}**`,
        ].join('\n'), inline: false },

        // Görev özeti
        { name: '📋 Görevler', value: [
          `✅ Tamamlanan: **${taskStats.completed}**`,
          `⏳ Bekleyen: **${taskStats.pending}**`,
          `⚠️ Zorunlu Yapılan: **${taskStats.mandatory_done}**`,
        ].join('\n'), inline: true },
        // Son 7 gün tamamlama oranı
        { name: '📈 Son 7 Gün', value: (() => {
          const done  = parseInt(taskStats.completed_7d ?? 0);
          const total = parseInt(taskStats.assigned_7d  ?? 0);
          if (!total) return '*Bu hafta görev atanmadı*';
          const pct   = Math.round((done / total) * 100);
          const filled = Math.floor(pct / 10);
          const bar   = '█'.repeat(filled) + '░'.repeat(10 - filled);
          return `\`${bar}\` ${pct}%\n**${done}** / **${total}** tamamlandı`;
        })(), inline: true },

        // Rol
        { name: '🎭 Mevcut Rol', value: currentRole ? `<@&${currentRole.role_id}>` : '*Henüz rol yok*', inline: true },
      )
      .setTimestamp();

    if (seasonFooter) embed.setFooter({ text: seasonFooter });

    // Sonraki rol ilerleme çubuğu
    if (nextRole && nextRole.xp_required > 0) {
      const needed = nextRole.xp_required;
      const pct = Math.min(100, Math.floor((totalXP / needed) * 100));
      const filled = Math.floor(pct / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      embed.addFields({
        name: `🚀 Sonraki Rol: <@&${nextRole.role_id}>`,
        value: `\`${bar}\` ${pct}% · **${totalXP.toFixed(1)}** / **${needed}** XP`,
        inline: false,
      });
    }

    // Son XP hareketleri
    if (xpLogs.length) {
      const logLines = xpLogs.map(l => {
        const ts = Math.floor(new Date(l.created_at).getTime() / 1000);
        const label = typeLabel[l.type] ?? '⭐';
        const sign = l.amount >= 0 ? `+${parseFloat(l.amount).toFixed(1)}` : parseFloat(l.amount).toFixed(1);
        return `${label} **${sign}** XP · <t:${ts}:R>${l.reason ? ` · *${l.reason.slice(0, 40)}*` : ''}`;
      }).join('\n');
      embed.addFields({ name: '🕑 Son XP Hareketleri', value: logLines, inline: false });
    }

    return interaction.editReply({ embeds: [embed] });
  },
};

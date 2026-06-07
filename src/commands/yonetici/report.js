const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { pool } = require('../../utils/database');
const { getInactiveStaff, formatTime, activityScore } = require('../../utils/activityTracker');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Aktivite raporunu gösterir')
    .addStringOption(opt =>
      opt.setName('aralik')
        .setDescription('Zaman aralığı')
        .setRequired(false)
        .addChoices(
          { name: '📅 Bugün',  value: '1'  },
          { name: '📅 7 Gün',  value: '7'  },
          { name: '📅 30 Gün', value: '30' },
        )
    )
    .addUserOption(opt =>
      opt.setName('kullanici')
        .setDescription('Belirli bir kullanıcının haftalık detayı (boş = sunucu geneli)')
        .setRequired(false)
    ),
  category: 'yonetici',

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const days    = parseInt(interaction.options.getString('aralik') ?? '7');
    const target  = interaction.options.getUser('kullanici');
    const guildId = interaction.guild.id;
    const label   = days === 1 ? 'Bugün' : `Son ${days} Gün`;

    // ── KİŞİ BAZLI rapor ────────────────────────────────────────
    if (target) {
      const [msgRes, voiceRes, partnerRes, taskRes] = await Promise.all([
        // mesaj sayısı
        pool.query(`
          SELECT COUNT(*) AS cnt
          FROM message_logs
          WHERE guild_id = $1 AND user_id = $2
            AND created_at > NOW() - INTERVAL '${days} days'
        `, [guildId, target.id]),

        // ses süresi
        pool.query(`
          SELECT COALESCE(SUM(duration_seconds), 0) AS total
          FROM voice_logs
          WHERE guild_id = $1 AND user_id = $2
            AND left_at > NOW() - INTERVAL '${days} days'
        `, [guildId, target.id]),

        // partnerlik sayısı
        pool.query(`
          SELECT COUNT(*) AS cnt
          FROM partnership_logs
          WHERE guild_id = $1 AND user_id = $2
            AND created_at > NOW() - INTERVAL '${days} days'
        `, [guildId, target.id]),

        // tamamlanan görev sayısı
        pool.query(`
          SELECT COUNT(*) AS cnt
          FROM task_assignments ta
          JOIN tasks t ON t.id = ta.task_id
          WHERE t.guild_id = $1 AND ta.user_id = $2
            AND ta.status = 'tamamlandı'
            AND ta.completed_at > NOW() - INTERVAL '${days} days'
        `, [guildId, target.id]),
      ]);

      const msgs      = parseInt(msgRes.rows[0].cnt ?? 0);
      const voiceSec  = parseInt(voiceRes.rows[0].total ?? 0);
      const partners  = parseInt(partnerRes.rows[0].cnt ?? 0);
      const tasks     = parseInt(taskRes.rows[0].cnt ?? 0);

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${label} — ${target.displayName ?? target.username}`)
        .setColor(0x9966ff)
        .setThumbnail(target.displayAvatarURL())
        .setTimestamp()
        .addFields(
          { name: '💬 Mesaj',        value: `**${msgs}** mesaj`,                 inline: true },
          { name: '🎙️ Ses',         value: `**${formatTime(voiceSec)}**`,        inline: true },
          { name: '🤝 Partnerlik',   value: `**${partners}** partnerlik`,         inline: true },
          { name: '✅ Görev',        value: `**${tasks}** tamamlanan görev`,      inline: true },
        );

      return interaction.editReply({ embeds: [embed] });
    }

    // ── SUNUCU GENELİ rapor ─────────────────────────────────────
    const [msgRes, voiceRes, partnerRes, modRes, inactiveStaff] = await Promise.all([
      pool.query(`
        SELECT user_id, username, COUNT(*) AS count
        FROM message_logs
        WHERE guild_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
        GROUP BY user_id, username
        ORDER BY count DESC
        LIMIT 5
      `, [guildId]),

      pool.query(`
        SELECT user_id, username, SUM(duration_seconds) AS total
        FROM voice_logs
        WHERE guild_id = $1 AND left_at > NOW() - INTERVAL '${days} days'
        GROUP BY user_id, username
        ORDER BY total DESC
        LIMIT 5
      `, [guildId]),

      pool.query(`
        SELECT user_id, username, COUNT(*) AS cnt
        FROM partnership_logs
        WHERE guild_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
        GROUP BY user_id, username
        ORDER BY cnt DESC
        LIMIT 5
      `, [guildId]),

      pool.query(`
        SELECT action_type, COUNT(*) AS count
        FROM mod_logs
        WHERE guild_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
        GROUP BY action_type
        ORDER BY count DESC
      `, [guildId]),

      getInactiveStaff(guildId, days),
    ]);

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${label} — Aktivite Raporu`)
      .setColor(0x9966ff)
      .setTimestamp();

    // En çok mesaj
    const msgLines = msgRes.rows.length
      ? msgRes.rows.map((r, i) => `**${i + 1}.** ${r.username} — ${r.count} mesaj`).join('\n')
      : 'Veri yok';
    embed.addFields({ name: '💬 En Çok Mesaj', value: msgLines, inline: true });

    // En çok ses
    const voiceLines = voiceRes.rows.length
      ? voiceRes.rows.map((r, i) => `**${i + 1}.** ${r.username} — ${formatTime(Number(r.total))}`).join('\n')
      : 'Veri yok';
    embed.addFields({ name: '🎙️ En Çok Ses', value: voiceLines, inline: true });

    // En çok partnerlik
    const partnerLines = partnerRes.rows.length
      ? partnerRes.rows.map((r, i) => `**${i + 1}.** ${r.username} — ${r.cnt} partnerlik`).join('\n')
      : 'Veri yok';
    embed.addFields({ name: '🤝 En Çok Partnerlik', value: partnerLines, inline: true });

    // Mod işlemleri
    const modLines = modRes.rows.length
      ? modRes.rows.map(r => `${r.action_type}: **${r.count}**`).join('\n')
      : 'İşlem yok';
    embed.addFields({ name: '⚖️ Mod İşlemleri', value: modLines, inline: false });

    // İnaktif yetkililer
    const inactiveLines = inactiveStaff.length
      ? inactiveStaff.map(u =>
          `⚠️ **${u.username}** — ${u.last_seen
            ? `<t:${Math.floor(new Date(u.last_seen).getTime() / 1000)}:R>`
            : 'hiç görülmedi'}`
        ).join('\n')
      : '✅ Tüm yetkililer aktif';
    embed.addFields({ name: `😴 ${days} Gündür İnaktif`, value: inactiveLines, inline: false });

    return interaction.editReply({ embeds: [embed] });
  },
};

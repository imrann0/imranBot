const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../utils/database');
const { activityScore, formatTime } = require('../../utils/activityTracker');
const { getCurrentSeason } = require('../../utils/seasonManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Yetkili sıralamasını gösterir')
    .addStringOption(opt =>
      opt.setName('sort')
        .setDescription('Sıralama kriteri')
        .setRequired(false)
        .addChoices(
          { name: '⭐ Toplam Skor',   value: 'score'    },
          { name: '💬 Mesaj',         value: 'messages' },
          { name: '🎙️ Ses Süresi',   value: 'voice'    },
          { name: '🎯 Görev Puanı',   value: 'tasks'    },
          { name: '🔥 Streak',        value: 'streak'   },
        )
    ),
  category: 'genel',

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sort    = interaction.options.getString('sort') ?? 'score';
    const guildId = interaction.guild.id;

    // Activity + streak bilgilerini birleştir
    const res = await pool.query(`
      SELECT
        a.user_id, a.username,
        a.messages, a.voice_seconds,
        COALESCE(a.message_score,0)           AS message_score,
        COALESCE(a.voice_score,0)             AS voice_score,
        COALESCE(a.task_points,0)             AS task_points,
        COALESCE(a.mandatory_task_points,0)   AS mandatory_task_points,
        COALESCE(a.responsibility_points,0)   AS responsibility_points,
        COALESCE(a.manual_points,0)           AS manual_points,
        COALESCE(u.streak, 0)                 AS streak
      FROM activity a
      LEFT JOIN rs_users u ON u.guild_id = a.guild_id AND u.user_id = a.user_id
      WHERE a.guild_id = $1
    `, [guildId]);

    if (!res.rows.length) {
      return interaction.editReply({ content: '❌ Henüz veri yok.' });
    }

    // Sıralama
    const rows = res.rows.map(r => ({
      ...r,
      totalScore: activityScore(r),
      taskTotal: parseFloat(r.task_points) + parseFloat(r.mandatory_task_points),
    }));

    if (sort === 'score')    rows.sort((a, b) => b.totalScore - a.totalScore);
    if (sort === 'messages') rows.sort((a, b) => b.messages - a.messages);
    if (sort === 'voice')    rows.sort((a, b) => Number(b.voice_seconds) - Number(a.voice_seconds));
    if (sort === 'tasks')    rows.sort((a, b) => b.taskTotal - a.taskTotal);
    if (sort === 'streak')   rows.sort((a, b) => b.streak - a.streak);

    const medals = ['🥇', '🥈', '🥉'];
    const top = rows.slice(0, 10);

    // Kullanıcının kendi sırası
    const callerId   = interaction.user.id;
    const callerRank = rows.findIndex(r => r.user_id === callerId);
    const callerRow  = callerRank !== -1 ? rows[callerRank] : null;

    const formatLine = (r, rank) => {
      const medal = medals[rank] ?? `**${rank + 1}.**`;
      const streak = r.streak > 1 ? ` 🔥${r.streak}` : '';
      if (sort === 'voice')    return `${medal} **${r.username}** — 🎙️ ${formatTime(Number(r.voice_seconds))}${streak}`;
      if (sort === 'messages') return `${medal} **${r.username}** — 💬 ${r.messages} mesaj${streak}`;
      if (sort === 'tasks')    return `${medal} **${r.username}** — 🎯 ${r.taskTotal.toFixed(1)} puan${streak}`;
      if (sort === 'streak')   return `${medal} **${r.username}** — 🔥 ${r.streak} hafta`;
      return `${medal} **${r.username}** — ⭐ ${r.totalScore.toFixed(1)} XP${streak}`;
    };

    const titleMap = {
      score:    'Toplam Skor',
      messages: 'Mesaj',
      voice:    'Ses Süresi',
      tasks:    'Görev Puanı',
      streak:   'Streak',
    };

    const currentSeason = await getCurrentSeason(guildId);
    const seasonLabel   = currentSeason ? `📅 ${currentSeason.name}` : '';

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Leaderboard — ${titleMap[sort]}`)
      .setColor(0xffcc00)
      .setDescription(top.map((r, i) => formatLine(r, i)).join('\n'))
      .setTimestamp();

    // Footer: sıra + aktif sezon
    const footerParts = [];
    if (callerRow && callerRank >= 10) footerParts.push(`Sıran: #${callerRank + 1} · ${callerRow.totalScore.toFixed(1)} XP`);
    if (seasonLabel) footerParts.push(seasonLabel);
    if (footerParts.length) embed.setFooter({ text: footerParts.join('  ·  ') });

    return interaction.editReply({ embeds: [embed] });
  },
};

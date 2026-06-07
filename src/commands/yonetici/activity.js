const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getAll, getUser, getUserMessages, getUserVoiceLogs, getTopChannel, getPeakHour, formatTime, activityScore } = require('../../utils/activityTracker');
const { getCurrentSeason } = require('../../utils/seasonManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('activity')
    .setDescription('Yetkili aktivite raporunu gösterir')
    .addUserOption(opt =>
      opt.setName('kullanici').setDescription('Belirli bir kullanıcı (boş = hepsi)').setRequired(false)
    ),
  category: 'yonetici',
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getUser('kullanici');
    const guildId = interaction.guild.id;
    const currentSeason = await getCurrentSeason(guildId);
    const seasonFooter  = currentSeason ? `📅 ${currentSeason.name}` : 'Aktif sezon yok';

    // ── Tek kullanıcı ─────────────────────────────────────────
    if (target) {
      const [u, logs, voiceLogs, topChannel, peakHour] = await Promise.all([
        getUser(guildId, target.id),
        getUserMessages(guildId, target.id, 5),
        getUserVoiceLogs(guildId, target.id, 5),
        getTopChannel(guildId, target.id),
        getPeakHour(guildId, target.id),
      ]);

      if (!u) return interaction.editReply({ content: '❌ Bu kullanıcıya ait veri yok.' });

      const score       = activityScore(u);
      const msgPoints   = parseFloat(u.message_score         ?? 0).toFixed(1);
      const voicePoints = parseFloat(u.voice_score           ?? 0).toFixed(1);
      const mandPts     = parseFloat(u.mandatory_task_points ?? 0).toFixed(1);
      const taskPts     = parseFloat(u.task_points           ?? 0).toFixed(1);
      const manualPts   = parseFloat(u.manual_points         ?? 0).toFixed(1);
      const respPts     = parseFloat(u.responsibility_points ?? 0).toFixed(1);

      const lastMessages = logs.length
        ? logs.map(m => `**#${m.channel_name}**: ${m.content.slice(0, 60)}${m.reply_to_username ? ` *(→ ${m.reply_to_username})*` : ''}`).join('\n')
        : '*Mesaj yok*';
      const lastVoice = voiceLogs.length
        ? voiceLogs.map(v => `**#${v.channel_name}**: ${formatTime(Number(v.duration_seconds))} — <t:${Math.floor(new Date(v.left_at).getTime() / 1000)}:R>`).join('\n')
        : '*Ses logu yok*';

      const peakHourStr = peakHour ? `${peakHour.hour}:00–${peakHour.hour + 1}:00 (${peakHour.count} mesaj)` : 'Bilinmiyor';

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${u.username} Aktivitesi`)
        .setColor(0x9966ff)
        .setThumbnail(target.displayAvatarURL())
        .setDescription([
          `⭐ **Toplam Skor: ${score} puan**`,
          `💬 Mesaj: **${msgPoints}p** • 🎙️ Ses: **${voicePoints}p** • ⚠️ Zorunlu: **${mandPts}p**`,
          `🎯 İsteğe Bağlı: **${taskPts}p** • 📌 Sorumluluk: **${respPts}p** • ✨ Manuel: **${manualPts}p**`,
        ].join('\n'))
        .addFields(
          { name: '💬 Mesaj Sayısı',    value: `${u.messages ?? 0}`,                                                                      inline: true },
          { name: '🎙️ Toplam Ses',      value: formatTime(Number(u.voice_seconds ?? 0)),                                                   inline: true },
          { name: '📍 En Aktif Kanal',  value: topChannel ? `#${topChannel.channel_name} (${topChannel.count})` : 'Bilinmiyor',           inline: true },
          { name: '🕐 En Aktif Saat',   value: peakHourStr,                                                                                inline: true },
          { name: '👁️ Son Görülme',     value: u.last_seen ? `<t:${Math.floor(new Date(u.last_seen).getTime() / 1000)}:R>` : 'Bilinmiyor', inline: true },
          { name: '📝 Son 5 Mesaj',     value: lastMessages,                                                                               inline: false },
          { name: '🎙️ Son 5 Ses Oturumu', value: lastVoice,                                                                               inline: false },
        )
        .setFooter({ text: seasonFooter })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── Tüm kullanıcılar ──────────────────────────────────────
    const rows = await getAll(guildId);
    if (!rows.length) return interaction.editReply({ content: '❌ Henüz veri yok.' });

    // Puana göre sırala
    const sorted = rows
      .map(u => ({ ...u, score: activityScore(u) }))
      .sort((a, b) => b.score - a.score);

    const medals = ['🥇', '🥈', '🥉'];

    // Her satır: sıra · kullanıcı adı · toplam puan · kategori puanları
    const lines = sorted.map((u, i) => {
      const medal  = medals[i] ?? '    ';
      const rank   = String(i + 1).padStart(2, '0');
      const name   = u.username.slice(0, 14).padEnd(14, ' ');
      const score  = String(u.score).padStart(6, ' ');
      const msg    = parseFloat(u.message_score         ?? 0).toFixed(0);
      const voice  = parseFloat(u.voice_score           ?? 0).toFixed(0);
      const task   = parseFloat((parseFloat(u.task_points ?? 0) + parseFloat(u.mandatory_task_points ?? 0) + parseFloat(u.responsibility_points ?? 0))).toFixed(0);
      const manual = parseFloat(u.manual_points ?? 0).toFixed(0);
      return `${medal} \`${rank}.\` **${u.username.slice(0, 16)}** — ⭐ ${u.score}p  💬 ${msg}  🎙️ ${voice}  📋 ${task}  ✨ ${manual}`;
    });

    // Birden fazla embed (Discord 4096 karakter limiti)
    const chunkSize = 20;
    const embeds = [];
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunk = lines.slice(i, i + chunkSize);
      embeds.push(
        new EmbedBuilder()
          .setTitle(i === 0 ? '📊 Yetkili Aktivite Raporu' : `📊 Yetkili Aktivite Raporu (devam)`)
          .setColor(0x9966ff)
          .setDescription(chunk.join('\n'))
          .setFooter({ text: `${sorted.length} yetkili • ⭐ Skor  💬 Mesaj  🎙️ Ses  📋 Görev  ✨ Manuel | ${seasonFooter}` })
      );
    }

    return interaction.editReply({ embeds: embeds.slice(0, 10) });
  },
};

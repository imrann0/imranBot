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
    const target = interaction.options.getUser('kullanici');

    const guildId = interaction.guild.id;
    const currentSeason = await getCurrentSeason(guildId);
    const seasonFooter  = currentSeason ? `📅 ${currentSeason.name}` : null;

    if (target) {
      const [u, logs, voiceLogs, topChannel, peakHour] = await Promise.all([
        getUser(guildId, target.id),
        getUserMessages(guildId, target.id, 5),
        getUserVoiceLogs(guildId, target.id, 5),
        getTopChannel(guildId, target.id),
        getPeakHour(guildId, target.id),
      ]);

      if (!u) {
        return interaction.reply({ content: '❌ Bu kullanıcıya ait veri yok.', flags: MessageFlags.Ephemeral });
      }

      const score = activityScore(u);
      const msgPoints      = u.message_score         ?? 0;
      const voicePoints    = u.voice_score           ?? 0;
      const mandatoryPts   = u.mandatory_task_points ?? 0;
      const taskPts        = u.task_points           ?? 0;
      const manualPts      = u.manual_points         ?? 0;
      const scoreBreakdown = [
        `💬 Mesaj: **${msgPoints}p**`,
        `🎙️ Ses: **${voicePoints}p**`,
        `⚠️ Zorunlu Görev: **${mandatoryPts}p**`,
        `🎯 İsteğe Bağlı: **${taskPts}p**`,
        `⭐ Manuel: **${manualPts}p**`,
      ].join(' • ');

      const lastMessages = logs.length
        ? logs.map(m => `**#${m.channel_name}**: ${m.content.slice(0, 60)}${m.reply_to_username ? ` *(→ ${m.reply_to_username})*` : ''}`).join('\n')
        : 'Mesaj yok';
      const lastVoice = voiceLogs.length
        ? voiceLogs.map(v => `**#${v.channel_name}**: ${formatTime(Number(v.duration_seconds))} — <t:${Math.floor(new Date(v.left_at).getTime() / 1000)}:R>`).join('\n')
        : 'Ses logu yok';

      const peakHourStr = peakHour ? `${peakHour.hour}:00–${peakHour.hour + 1}:00 (${peakHour.count} mesaj)` : 'Bilinmiyor';

      const embed = new EmbedBuilder()
        .setTitle(`📊 ${u.username} Aktivitesi`)
        .addFields(
          { name: '⭐ Toplam Skor', value: `**${score}** puan\n${scoreBreakdown}`, inline: false },
          { name: '💬 Mesaj', value: `${u.messages}`, inline: true },
          { name: '🎙️ Toplam Ses', value: formatTime(Number(u.voice_seconds)), inline: true },
          { name: '⚠️ Zorunlu Görev', value: `${mandatoryPts}`, inline: true },
          { name: '🎯 İsteğe Bağlı', value: `${taskPts}`,     inline: true },
          { name: '⭐ Manuel Puan',   value: `${manualPts}`,   inline: true },
          { name: '📍 En Aktif Kanal', value: topChannel ? `#${topChannel.channel_name} (${topChannel.count})` : 'Bilinmiyor', inline: true },
          { name: '🕐 En Aktif Saat', value: peakHourStr, inline: true },
          { name: '👁️ Son Görülme', value: u.last_seen ? `<t:${Math.floor(new Date(u.last_seen).getTime() / 1000)}:R>` : 'Bilinmiyor', inline: true },
          { name: '📝 Son 5 Mesaj', value: lastMessages },
          { name: '🎙️ Son 5 Ses Oturumu', value: lastVoice },
        )
        .setColor(0x9966ff)
        .setThumbnail(target.displayAvatarURL())
        .setTimestamp();

      if (seasonFooter) embed.setFooter({ text: seasonFooter });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const rows = await getAll(guildId);
    if (!rows.length) {
      return interaction.reply({ content: '❌ Henüz veri yok.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 Yetkili Aktivite Raporu')
      .setColor(0x9966ff)
      .setTimestamp();

    if (seasonFooter) embed.setFooter({ text: seasonFooter });

    for (const u of rows.slice(0, 10)) {
      const score = activityScore(u);
      embed.addFields({
        name: `${u.username} — ⭐ ${score} puan`,
        value: `💬 ${u.message_score ?? 0}p • 🎙️ ${u.voice_score ?? 0}p • 📌 ${u.task_points ?? 0}p • ⭐ ${u.manual_points ?? 0}p`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

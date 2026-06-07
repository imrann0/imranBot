const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getUserModLogs, getRecentModLogs, formatTime } = require('../../utils/activityTracker');

const ACTION_COLORS = {
  'Kick':             0xff8800,
  'Ban':              0xff0000,
  'Unban':            0x00ff88,
  'Timeout':          0xffcc00,
  'Rol Değişimi':     0x8888ff,
  'Mesaj Silindi':    0xaaaaaa,
};

const ACTION_EMOJI = {
  'Kick':             '👢',
  'Ban':              '🔨',
  'Unban':            '✅',
  'Timeout':          '⏱️',
  'Rol Değişimi':     '🎭',
  'Mesaj Silindi':    '🗑️',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('Moderasyon loglarını gösterir')
    .addUserOption(opt => opt.setName('kullanici').setDescription('Belirli kullanıcı (boş = son 20 işlem)').setRequired(false)),
  category: 'yonetici',
  async execute(interaction) {
    const target = interaction.options.getUser('kullanici');

    const guildId = interaction.guild.id;
    const logs = target
      ? await getUserModLogs(guildId, target.id, 15)
      : await getRecentModLogs(guildId, 20);

    if (!logs.length) {
      return interaction.reply({ content: '❌ Mod logu yok.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
      .setTitle(target ? `⚖️ ${target.username} — Mod Geçmişi` : '⚖️ Son Moderasyon İşlemleri')
      .setColor(0xff4444)
      .setTimestamp();

    if (target) embed.setThumbnail(target.displayAvatarURL());

    for (const log of logs) {
      const emoji = ACTION_EMOJI[log.action_type] ?? '⚙️';
      const ts = Math.floor(new Date(log.created_at).getTime() / 1000);
      const duration = log.duration_seconds ? ` • Süre: ${formatTime(Number(log.duration_seconds))}` : '';
      const reason = log.reason ? `\nNeden: *${log.reason}*` : '';
      const executor = log.executor_username ? `Yapan: **${log.executor_username}**` : 'Yapan: bilinmiyor';
      const targetStr = target ? '' : `Hedef: **${log.target_username}** • `;

      embed.addFields({
        name: `${emoji} ${log.action_type} — <t:${ts}:R>`,
        value: `${targetStr}${executor}${duration}${reason}`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

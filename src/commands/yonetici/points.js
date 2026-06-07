const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { addManualPoints, getManualPointLogs, getUser, logPointsToChannel } = require('../../utils/activityTracker');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('points')
    .setDescription('Manuel puan ekle veya geçmişini gör')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Kullanıcıya manuel puan ekle')
        .addUserOption(opt => opt.setName('kullanici').setDescription('Kullanıcı').setRequired(true))
        .addIntegerOption(opt => opt.setName('miktar').setDescription('Eklenecek puan (negatif = çıkar)').setRequired(true))
        .addStringOption(opt => opt.setName('sebep').setDescription('Sebep').setRequired(false).setMaxLength(200))
    )
    .addSubcommand(sub =>
      sub.setName('history')
        .setDescription('Manuel puan geçmişini gör')
        .addUserOption(opt => opt.setName('kullanici').setDescription('Kullanıcı').setRequired(true))
    ),
  category: 'yonetici',

  async execute(interaction) {
    const sub    = interaction.options.getSubcommand();
    const target = interaction.options.getUser('kullanici');

    const guildId = interaction.guild.id;

    if (sub === 'add') {
      const amount = interaction.options.getInteger('miktar');
      const reason = interaction.options.getString('sebep') ?? null;

      await addManualPoints(
        guildId, target.id, target.username,
        amount, reason,
        interaction.user.id, interaction.user.username
      );

      await logPointsToChannel(interaction.client, guildId, {
        userId: target.id, username: target.username,
        points: amount, source: 'manuel',
        detail: reason ? `${reason} *(veren: ${interaction.user.username})*` : `*(veren: ${interaction.user.username})*`,
      });

      const u = await getUser(guildId, target.id);
      const total = u?.manual_points ?? 0;
      const sign  = amount >= 0 ? `+${amount}` : `${amount}`;

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(amount >= 0 ? 0x44cc88 : 0xff6b6b)
            .setTitle(`⭐ Manuel Puan ${amount >= 0 ? 'Eklendi' : 'Çıkarıldı'}`)
            .setThumbnail(target.displayAvatarURL())
            .addFields(
              { name: '👤 Kullanıcı',   value: `<@${target.id}>`,           inline: true },
              { name: '📊 Değişim',     value: `**${sign} puan**`,           inline: true },
              { name: '💰 Toplam Manuel', value: `**${total} puan**`,        inline: true },
              { name: '📝 Sebep',       value: reason ?? '*Belirtilmedi*',   inline: false },
              { name: '👮 Veren',       value: `<@${interaction.user.id}>`, inline: true },
            )
            .setTimestamp(),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'history') {
      const logs = await getManualPointLogs(guildId, target.id, 15);

      if (!logs.length) {
        return interaction.reply({
          content: `❌ **${target.username}** için manuel puan kaydı yok.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const u     = await getUser(guildId, target.id);
      const total = u?.manual_points ?? 0;

      const lines = logs.map((l, i) => {
        const ts   = Math.floor(new Date(l.created_at).getTime() / 1000);
        const sign = l.points >= 0 ? `+${l.points}` : `${l.points}`;
        const reason = l.reason ? ` — *${l.reason}*` : '';
        return `\`${String(i + 1).padStart(2, '0')}\` **${sign}p** · <@${l.given_by_id}> · <t:${ts}:R>${reason}`;
      });

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9966ff)
            .setAuthor({ name: `${target.username} · Manuel Puan Geçmişi`, iconURL: target.displayAvatarURL() })
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Toplam manuel puan: ${total}` }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

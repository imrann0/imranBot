const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { getUserMessages } = require('../../utils/activityTracker');

const CHANNEL_COLORS = {
  0: 0x5599ff, 1: 0xff6b6b, 2: 0x44cc88, 3: 0xffcc00,
  4: 0xff9944, 5: 0xcc44ff, 6: 0x44ccff, 7: 0xff44aa,
};

function buildEmbed(target, logs, page, totalPages) {
  const start = page * 5;
  const slice = logs.slice(start, start + 5);

  const lines = slice.map((m, i) => {
    const ts = Math.floor(new Date(m.created_at).getTime() / 1000);
    const num = `\`${String(start + i + 1).padStart(2, '0')}\``;
    const channel = `**#${m.channel_name}**`;
    const time = `<t:${ts}:T> <t:${ts}:R>`;

    const rawContent = m.content ?? '';
    const content = rawContent.length > 120
      ? rawContent.slice(0, 120) + '…'
      : rawContent || '*[boş]*';

    let line = `${num} ${channel} · ${time}\n┗ ${content}`;

    if (m.reply_to_username) {
      const rc = (m.reply_to_content ?? '').slice(0, 60) || '[dosya/embed]';
      line += `\n　 ↩️ *${m.reply_to_username}:* \`${rc}\``;
    }

    return line;
  });

  const colorKey = target.id.charCodeAt(target.id.length - 1) % 8;

  return new EmbedBuilder()
    .setAuthor({
      name: `${target.username} · Son Mesajlar`,
      iconURL: target.displayAvatarURL(),
    })
    .setDescription(lines.join('\n\n') || '*Mesaj bulunamadı.*')
    .setColor(CHANNEL_COLORS[colorKey])
    .setFooter({ text: `Sayfa ${page + 1} / ${totalPages}  ·  Toplam ${logs.length} mesaj` });
}

function buildButtons(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('msg_prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId('msg_page')
      .setLabel(`${page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('msg_next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('messages')
    .setDescription('Kullanıcının mesaj loglarını gösterir')
    .addUserOption(opt => opt.setName('user').setDescription('Kullanıcı').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('limit').setDescription('Kaç mesaj gösterilsin (max 50)').setMinValue(1).setMaxValue(50)
    ),
  category: 'yonetici',

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const limit  = interaction.options.getInteger('limit') ?? 25;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const logs = await getUserMessages(guildId, target.id, limit);
    if (!logs.length) {
      return interaction.editReply({ content: `❌ **${target.username}** için mesaj logu bulunamadı.` });
    }

    const totalPages = Math.ceil(logs.length / 5);
    let page = 0;

    const reply = await interaction.editReply({
      embeds: [buildEmbed(target, logs, page, totalPages)],
      components: totalPages > 1 ? [buildButtons(page, totalPages)] : [],
    });

    if (totalPages <= 1) return;

    const collector = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 120_000,
    });

    collector.on('collect', async i => {
      if (i.customId === 'msg_prev' && page > 0) page--;
      else if (i.customId === 'msg_next' && page < totalPages - 1) page++;
      await i.update({
        embeds: [buildEmbed(target, logs, page, totalPages)],
        components: [buildButtons(page, totalPages)],
      });
    });

    collector.on('end', async () => {
      try {
        await reply.edit({ components: [] });
      } catch {}
    });
  },
};

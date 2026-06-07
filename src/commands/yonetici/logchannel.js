const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ChannelSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, MessageFlags, ChannelType,
} = require('discord.js');
const { blockChannel, unblockChannel, getBlockedChannels } = require('../../utils/blockedChannels');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('logchannel')
    .setDescription('Mesaj loglamasından kanal engelle/kaldır')
    .addSubcommand(sub =>
      sub.setName('block').setDescription('Kanalları loglama dışı bırak')
    )
    .addSubcommand(sub =>
      sub.setName('unblock').setDescription('Kanalların engelini kaldır')
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Engellenen kanalları listele')
    ),
  category: 'yonetici',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    const guildId = interaction.guild.id;

    // ── /logchannel list ──────────────────────────────────────
    if (sub === 'list') {
      const rows = await getBlockedChannels(guildId);
      const embed = new EmbedBuilder()
        .setTitle('🚫 Loglama Dışı Kanallar')
        .setColor(0xff6b6b);

      if (!rows.length) {
        embed.setDescription('*Engellenen kanal yok — tüm kanallar loglanıyor.*');
      } else {
        embed.setDescription(
          rows.map((r, i) => {
            const ts = Math.floor(new Date(r.added_at).getTime() / 1000);
            return `\`${String(i + 1).padStart(2, '0')}\` <#${r.channel_id}> · <t:${ts}:R>`;
          }).join('\n')
        );
        embed.setFooter({ text: `${rows.length} kanal engellendi` });
      }
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── /logchannel block & unblock ───────────────────────────
    const isBlock = sub === 'block';

    const selectMenu = new ChannelSelectMenuBuilder()
      .setCustomId('logchannel_select')
      .setPlaceholder(isBlock ? 'Engellenecek kanalları seç…' : 'Engeli kalkacak kanalları seç…')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)
      .setMinValues(1)
      .setMaxValues(25);

    const confirmBtn = new ButtonBuilder()
      .setCustomId('logchannel_confirm')
      .setLabel(isBlock ? 'Engelle' : 'Engeli Kaldır')
      .setStyle(isBlock ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(true);

    const cancelBtn = new ButtonBuilder()
      .setCustomId('logchannel_cancel')
      .setLabel('İptal')
      .setStyle(ButtonStyle.Secondary);

    const reply = await interaction.reply({
      content: isBlock
        ? '🚫 Loglama dışı bırakılacak kanalları seç:'
        : '✅ Engeli kaldırılacak kanalları seç:',
      components: [
        new ActionRowBuilder().addComponents(selectMenu),
        new ActionRowBuilder().addComponents(confirmBtn, cancelBtn),
      ],
      flags: MessageFlags.Ephemeral,
    });

    let selectedChannels = [];

    const collector = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 60_000,
    });

    collector.on('collect', async i => {
      if (i.customId === 'logchannel_cancel') {
        collector.stop('cancel');
        return i.update({ content: '❌ İptal edildi.', components: [] });
      }

      if (i.customId === 'logchannel_select') {
        selectedChannels = i.channels ? [...i.channels.values()] : [];

        const updatedConfirm = ButtonBuilder.from(confirmBtn).setDisabled(selectedChannels.length === 0);
        await i.update({
          components: [
            new ActionRowBuilder().addComponents(selectMenu),
            new ActionRowBuilder().addComponents(updatedConfirm, cancelBtn),
          ],
        });
        return;
      }

      if (i.customId === 'logchannel_confirm') {
        collector.stop('confirm');

        if (isBlock) {
          await Promise.all(selectedChannels.map(ch => blockChannel(guildId, ch.id, ch.name, interaction.user.id)));
          await i.update({
            content: `🚫 **${selectedChannels.length} kanal** engellendi:\n${selectedChannels.map(ch => `• <#${ch.id}>`).join('\n')}`,
            components: [],
          });
        } else {
          await Promise.all(selectedChannels.map(ch => unblockChannel(guildId, ch.id)));
          await i.update({
            content: `✅ **${selectedChannels.length} kanalın** engeli kaldırıldı:\n${selectedChannels.map(ch => `• <#${ch.id}>`).join('\n')}`,
            components: [],
          });
        }
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'time') {
        try { await reply.edit({ content: '⏱️ Süre doldu.', components: [] }); } catch {}
      }
    });
  },
};

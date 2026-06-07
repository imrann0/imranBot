const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  RoleSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { addRole, removeRole, getRoles } = require('../../utils/staffRoles');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listenroles')
    .setDescription('Dinlenecek yetkili rollerini yönetir')
    .addSubcommand(sub => sub.setName('add').setDescription('Dinlenecek rol ekle'))
    .addSubcommand(sub => sub.setName('remove').setDescription('Dinlenen rolü kaldır'))
    .addSubcommand(sub => sub.setName('list').setDescription('Dinlenen rolleri listele'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  category: 'yonetici',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    const guildId = interaction.guild.id;

    if (sub === 'list') {
      const roles = await getRoles(guildId);
      const embed = new EmbedBuilder()
        .setTitle('📋 Dinlenen Roller')
        .setColor(0x9966ff);
      if (!roles.length) {
        embed.setDescription('*Henüz dinlenen rol yok.*');
      } else {
        embed.setDescription(
          roles.map((r, i) => {
            const ts = Math.floor(new Date(r.added_at).getTime() / 1000);
            return `\`${String(i + 1).padStart(2, '0')}\` <@&${r.role_id}> · Ekleyen: **${r.added_by ?? 'bilinmiyor'}** · <t:${ts}:R>`;
          }).join('\n')
        );
        embed.setFooter({ text: `${roles.length} rol dinleniyor` });
      }
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const isAdd = sub === 'add';

    const selectMenu = new RoleSelectMenuBuilder()
      .setCustomId('listenroles_select')
      .setPlaceholder(isAdd ? 'Eklenecek rolleri seç…' : 'Kaldırılacak rolleri seç…')
      .setMinValues(1)
      .setMaxValues(25);

    const confirmBtn = new ButtonBuilder()
      .setCustomId('listenroles_confirm')
      .setLabel(isAdd ? 'Ekle' : 'Kaldır')
      .setStyle(isAdd ? ButtonStyle.Success : ButtonStyle.Danger)
      .setDisabled(true);

    const cancelBtn = new ButtonBuilder()
      .setCustomId('listenroles_cancel')
      .setLabel('İptal')
      .setStyle(ButtonStyle.Secondary);

    const reply = await interaction.reply({
      content: isAdd ? '➕ Dinlenecek rolleri seç:' : '🗑️ Kaldırılacak rolleri seç:',
      components: [
        new ActionRowBuilder().addComponents(selectMenu),
        new ActionRowBuilder().addComponents(confirmBtn, cancelBtn),
      ],
      flags: MessageFlags.Ephemeral,
    });

    let selectedRoles = [];

    const collector = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 60_000,
    });

    collector.on('collect', async i => {
      if (i.customId === 'listenroles_cancel') {
        collector.stop('cancel');
        return i.update({ content: '❌ İptal edildi.', components: [] });
      }

      if (i.customId === 'listenroles_select') {
        selectedRoles = [...i.roles.values()];
        const updated = ButtonBuilder.from(confirmBtn).setDisabled(selectedRoles.length === 0);
        return i.update({
          components: [
            new ActionRowBuilder().addComponents(selectMenu),
            new ActionRowBuilder().addComponents(updated, cancelBtn),
          ],
        });
      }

      if (i.customId === 'listenroles_confirm') {
        collector.stop('confirm');

        if (isAdd) {
          await Promise.all(selectedRoles.map(r => addRole(guildId, r.id, r.name, interaction.user.username)));
          return i.update({
            embeds: [
              new EmbedBuilder()
                .setTitle('✅ Roller Eklendi')
                .setColor(0x44cc88)
                .setDescription(selectedRoles.map(r => `• <@&${r.id}> — *${r.name}*`).join('\n'))
                .setFooter({ text: `${selectedRoles.length} rol dinlemeye alındı` }),
            ],
            components: [],
          });
        } else {
          await Promise.all(selectedRoles.map(r => removeRole(guildId, r.id)));
          return i.update({
            embeds: [
              new EmbedBuilder()
                .setTitle('🗑️ Roller Kaldırıldı')
                .setColor(0xff6b6b)
                .setDescription(selectedRoles.map(r => `• <@&${r.id}> — *${r.name}*`).join('\n'))
                .setFooter({ text: `${selectedRoles.length} rol dinlemeden çıkarıldı` }),
            ],
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

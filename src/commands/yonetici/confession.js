const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const { pool } = require('../../utils/database');

async function setCfg(guildId, key, value) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (guild_id, key) DO UPDATE SET value = $3`,
    [guildId, key, value]
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('confession')
    .setDescription('İtiraf sistemini yönetir')
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('İtiraf panelini kur')
        .addChannelOption(o => o.setName('panel').setDescription('Butonun olacağı kanal').setRequired(true))
        .addChannelOption(o => o.setName('kanal').setDescription('İtirafların gönderileceği kanal').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('ac')
        .setDescription('İtiraf butonunu tekrar aktif et')
    )
    .addSubcommand(sub =>
      sub.setName('kapat')
        .setDescription('İtiraf butonunu geçici olarak kapat')
    ),
  category: 'yonetici',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── setup ──────────────────────────────────────────────────
    const guildId = interaction.guild.id;

    if (sub === 'setup') {
      const panelCh = interaction.options.getChannel('panel');
      const itirafCh = interaction.options.getChannel('kanal');

      await setCfg(guildId, 'itiraf_channel', itirafCh.id);
      await setCfg(guildId, 'itiraf_panel_channel', panelCh.id);

      const embed = new EmbedBuilder()
        .setColor(0xff69b4)
        .setTitle('💌 İtiraf Kutusu')
        .setDescription(
          'Aşağıdaki butona tıklayarak **anonim** itirafını gönderebilirsin.\n\n' +
          '> Kimliğin **hiç kimseyle** paylaşılmaz.\n' +
          '> İtirafın numaralandırılarak itiraf kanalına düşer.'
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('itiraf_open')
          .setLabel('İtiraf Gönder')
          .setEmoji('💌')
          .setStyle(ButtonStyle.Primary)
      );

      await panelCh.send({ embeds: [embed], components: [row] });
      await setCfg(guildId, 'itiraf_active', '1');

      return interaction.reply({
        content: `✅ İtiraf paneli ${panelCh} kanalına kuruldu. İtiraflar ${itirafCh} kanalına düşecek.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── ac ─────────────────────────────────────────────────────
    if (sub === 'ac') {
      await setCfg(guildId, 'itiraf_active', '1');
      return interaction.reply({ content: '✅ İtiraf butonu **açıldı**. Herkes itiraf gönderebilir.', flags: MessageFlags.Ephemeral });
    }

    // ── kapat ──────────────────────────────────────────────────
    if (sub === 'kapat') {
      await setCfg(guildId, 'itiraf_active', '0');
      return interaction.reply({ content: '🔒 İtiraf butonu **kapatıldı**. Kimse itiraf gönderemiyor.', flags: MessageFlags.Ephemeral });
    }

  },
};

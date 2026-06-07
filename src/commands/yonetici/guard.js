const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { pool } = require('../../utils/database');

async function setCfg(guildId, key, value) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, key) DO UPDATE SET value = $3`,
    [guildId, key, value]
  );
}

async function delCfg(guildId, key) {
  await pool.query(`DELETE FROM guild_config WHERE guild_id = $1 AND key = $2`, [guildId, key]);
}

async function getCfg(guildId, key) {
  const res = await pool.query(
    `SELECT value FROM guild_config WHERE guild_id = $1 AND key = $2`,
    [guildId, key]
  );
  return res.rows[0]?.value ?? null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('guard')
    .setDescription('Sunucu guard sistemini yönetir')
    .addSubcommand(sub =>
      sub.setName('vanity')
        .setDescription('Vanity URL koruma ayarla')
        .addStringOption(o =>
          o.setName('url').setDescription('Korunacak vanity URL kodu (örn: sekai)').setRequired(true)
        )
        .addChannelOption(o =>
          o.setName('log').setDescription('Değişiklik logu kanalı').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub.setName('durum')
        .setDescription('Guard durumunu göster')
    )
    .addSubcommand(sub =>
      sub.setName('rol-koruma')
        .setDescription('Yönetici/Manage Guild yetkisi veren kişiyi banlama sistemini kur')
        .addChannelOption(o =>
          o.setName('log').setDescription('Log kanalı').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('rol-koruma-kapat')
        .setDescription('Rol koruma sistemini kapat')
    )
    .addSubcommand(sub =>
      sub.setName('kapat')
        .setDescription('Tüm guard sistemini kapat')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  category: 'yonetici',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'vanity') {
      const code  = interaction.options.getString('url').replace('discord.gg/', '').trim();
      const logCh = interaction.options.getChannel('log');

      const current = interaction.guild.vanityURLCode;
      if (!current) {
        return interaction.reply({
          content: '❌ Bu sunucunun vanity URL özelliği yok. (Sunucu Level 3 gerekli)',
          flags: MessageFlags.Ephemeral,
        });
      }

      await setCfg(guildId, 'guard_vanity_code', code);
      if (logCh) await setCfg(guildId, 'guard_log_channel', logCh.id);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x44cc88)
            .setTitle('🛡️ Vanity URL Koruması Aktif')
            .addFields(
              { name: '🔗 Korunan URL', value: `discord.gg/**${code}**`, inline: true },
              { name: '📋 Log Kanalı',  value: logCh ? `${logCh}` : '*Ayarlanmadı*', inline: true },
            )
            .setDescription('Vanity URL değiştirilirse bot algılar ve değiştiren kişiyi banlar.')
            .setTimestamp(),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'durum') {
      const [code, logId, roleEnabled, roleLogId] = await Promise.all([
        getCfg(guildId, 'guard_vanity_code'),
        getCfg(guildId, 'guard_log_channel'),
        getCfg(guildId, 'guard_role_enabled'),
        getCfg(guildId, 'guard_role_log_channel'),
      ]);

      const embed = new EmbedBuilder()
        .setColor(code || roleEnabled === 'true' ? 0x44cc88 : 0xff6b6b)
        .setTitle('🛡️ Guard Durumu')
        .addFields(
          { name: '🔗 Vanity Koruma',        value: code           ? `✅ Aktif — discord.gg/**${code}**`                          : '❌ Kapalı', inline: false },
          { name: '📋 Vanity Log Kanalı',    value: logId          ? `<#${logId}>`                                                : '*Yok*',    inline: false },
          { name: '🔑 Yönetici Yetki Guard', value: roleEnabled === 'true' ? '✅ Aktif — Yönetici/Manage Guild yetkisi vereni banlar' : '❌ Kapalı', inline: false },
          { name: '📋 Rol Guard Log Kanalı', value: roleLogId      ? `<#${roleLogId}>`                                            : '*Yok*',    inline: false },
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'rol-koruma') {
      const logCh = interaction.options.getChannel('log');
      await setCfg(guildId, 'guard_role_log_channel', logCh.id);
      await setCfg(guildId, 'guard_role_enabled', 'true');
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x44cc88)
            .setTitle('🛡️ Rol Koruma Aktif')
            .setDescription('Birisi bir role **Yönetici** veya **Sunucuyu Yönet** yetkisi verirse bot o kişiyi otomatik banlar.')
            .addFields({ name: '📋 Log Kanalı', value: `${logCh}`, inline: true })
            .setTimestamp(),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'rol-koruma-kapat') {
      await delCfg(guildId, 'guard_role_log_channel');
      await delCfg(guildId, 'guard_role_enabled');
      return interaction.reply({ content: '✅ Rol koruma sistemi kapatıldı.', flags: MessageFlags.Ephemeral });
    }

    if (sub === 'kapat') {
      await delCfg(guildId, 'guard_vanity_code');
      await delCfg(guildId, 'guard_log_channel');
      await delCfg(guildId, 'guard_role_log_channel');
      await delCfg(guildId, 'guard_role_enabled');
      return interaction.reply({ content: '✅ Tüm guard sistemi kapatıldı.', flags: MessageFlags.Ephemeral });
    }
  },
};

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getConfig, setConfig } = require('../../utils/taskManager');
const { pool } = require('../../utils/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('partnership')
    .setDescription('Partnerlik sistemini yönetir')
    .addSubcommand(s => s
      .setName('setup')
      .setDescription('Partnerlik kanalını tanımla')
      .addChannelOption(o => o.setName('kanal').setDescription('Partnerlik mesajlarının atılacağı kanal').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('kapat')
      .setDescription('Partnerlik kanalı tanımını kaldır')
    )
    .addSubcommand(s => s
      .setName('durum')
      .setDescription('Mevcut partnerlik kanalını göster')
    )
    .addSubcommand(s => s
      .setName('liste')
      .setDescription('Bir kullanıcının partnerlik geçmişini göster')
      .addUserOption(o => o.setName('kullanici').setDescription('Kullanıcı (boş = sen)').setRequired(false))
    )
    .addSubcommand(s => s
      .setName('tümü')
      .setDescription('Tüm kullanıcıların partnerlik sayısını listele')
    ),
  category: 'yonetici',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // ── setup ─────────────────────────────────────────────────
    if (sub === 'setup') {
      const kanal = interaction.options.getChannel('kanal');
      await setConfig(guildId, 'partnership_channel', kanal.id);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x44cc88)
          .setTitle('🤝 Partnerlik Kanalı Ayarlandı')
          .setDescription(`${kanal} kanalına gönderilen mesajlar (bot hariç) partnerlik sayısına eklenecek.`)
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── kapat ─────────────────────────────────────────────────
    if (sub === 'kapat') {
      await pool.query(
        `DELETE FROM guild_config WHERE guild_id = $1 AND key = 'partnership_channel'`,
        [guildId]
      );
      return interaction.reply({ content: '✅ Partnerlik kanalı tanımı kaldırıldı.', flags: MessageFlags.Ephemeral });
    }

    // ── durum ─────────────────────────────────────────────────
    if (sub === 'durum') {
      const chId = await getConfig(guildId, 'partnership_channel');
      if (!chId) return interaction.reply({ content: '❌ Partnerlik kanalı henüz ayarlanmamış.', flags: MessageFlags.Ephemeral });
      return interaction.reply({
        content: `🤝 Partnerlik kanalı: <#${chId}>`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── liste ─────────────────────────────────────────────────
    if (sub === 'liste') {
      const target = interaction.options.getUser('kullanici') ?? interaction.user;

      const res = await pool.query(`
        SELECT created_at FROM partnership_logs
        WHERE guild_id = $1 AND user_id = $2
        ORDER BY created_at DESC
        LIMIT 20
      `, [guildId, target.id]);

      const total = (await pool.query(
        `SELECT COUNT(*) AS cnt FROM partnership_logs WHERE guild_id = $1 AND user_id = $2`,
        [guildId, target.id]
      )).rows[0].cnt;

      if (!res.rows.length) {
        return interaction.reply({ content: `📭 **${target.username}** henüz hiç partnerlik yapmamış.`, flags: MessageFlags.Ephemeral });
      }

      const lines = res.rows.map((r, i) => {
        const ts = Math.floor(new Date(r.created_at).getTime() / 1000);
        return `**${i + 1}.** <t:${ts}:F>`;
      }).join('\n');

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🤝 ${target.username} — Partnerlik Geçmişi`)
          .setDescription(lines)
          .setFooter({ text: `Toplam: ${total} partnerlik` })
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── tümü ──────────────────────────────────────────────────
    if (sub === 'tümü') {
      const rows = (await pool.query(`
        SELECT user_id, username, COUNT(*) AS total
        FROM partnership_logs
        WHERE guild_id = $1
        GROUP BY user_id, username
        ORDER BY total DESC
      `, [guildId])).rows;

      if (!rows.length) {
        return interaction.reply({ content: '📭 Henüz hiç partnerlik kaydı yok.', flags: MessageFlags.Ephemeral });
      }

      const grandTotal = rows.reduce((s, r) => s + parseInt(r.total), 0);

      const lines = rows.map((r, i) =>
        `**${i + 1}.** <@${r.user_id}> — **${r.total}** partnerlik`
      ).join('\n');

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🤝 Tüm Partnerlikler')
          .setDescription(lines)
          .setFooter({ text: `${rows.length} kişi · Toplam ${grandTotal} partnerlik` })
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

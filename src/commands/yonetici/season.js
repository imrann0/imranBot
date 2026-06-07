const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../../utils/database');
const {
  getCurrentSeason, listSeasons, getSeasonLeaderboard,
  startSeason, endSeason,
  buildSeasonEndEmbed, buildSeasonArchiveEmbed,
} = require('../../utils/seasonManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('season')
    .setDescription('Sezon sistemini yönetir')

    .addSubcommand(s => s
      .setName('baslat')
      .setDescription('Yeni bir sezon başlat')
      .addStringOption(o => o
        .setName('isim')
        .setDescription('Sezon adı (örn: Sezon 1, Yaz 2026)')
        .setRequired(true)
      )
    )

    .addSubcommand(s => s
      .setName('bitir')
      .setDescription('Aktif sezonu bitir — puanlar arşivlenir ve sıfırlanır')
    )

    .addSubcommand(s => s
      .setName('bilgi')
      .setDescription('Aktif sezon bilgisini göster')
    )

    .addSubcommand(s => s
      .setName('gecmis')
      .setDescription('Tüm geçmiş sezonları listele')
    )

    .addSubcommand(s => s
      .setName('arsiv')
      .setDescription('Geçmiş bir sezonun sıralamasını göster')
      .addIntegerOption(o => o
        .setName('sezon_id')
        .setDescription('Sezon ID (geçmiş listesinden öğren)')
        .setRequired(true)
      )
    ),

  category: 'yonetici',

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // ── baslat ───────────────────────────────────────────────────
    if (sub === 'baslat') {
      const isim = interaction.options.getString('isim');
      try {
        const season = await startSeason(guildId, isim);
        const started = Math.floor(new Date(season.started_at).getTime() / 1000);

        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle(`🚀 ${season.name} Başladı!`)
            .setColor(0x44cc88)
            .setDescription('Sezon başarıyla oluşturuldu. Puanlar artık bu sezon için sayılıyor.')
            .addFields(
              { name: '🆔 Sezon ID', value: `${season.id}`, inline: true },
              { name: '📅 Başlangıç', value: `<t:${started}:F>`, inline: true },
            )
            .setTimestamp()
          ],
        });
      } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
      }
    }

    // ── bitir ─────────────────────────────────────────────────────
    if (sub === 'bitir') {
      try {
        const { season, topRows } = await endSeason(guildId);
        const endEmbed = buildSeasonEndEmbed(season, topRows);

        // Log kanalına gönder
        const cfgRes = await pool.query(
          `SELECT value FROM guild_config WHERE guild_id = $1 AND key = 'rs_log_channel'`,
          [guildId]
        );
        if (cfgRes.rows[0]?.value) {
          const logChannel = interaction.guild.channels.cache.get(cfgRes.rows[0].value);
          if (logChannel) await logChannel.send({ embeds: [endEmbed] }).catch(() => {});
        }

        return interaction.editReply({
          embeds: [endEmbed],
          content: '✅ Sezon kapatıldı, arşivlendi ve puanlar sıfırlandı.',
        });
      } catch (err) {
        return interaction.editReply({ content: `❌ ${err.message}` });
      }
    }

    // ── bilgi ─────────────────────────────────────────────────────
    if (sub === 'bilgi') {
      const current = await getCurrentSeason(guildId);

      if (!current) {
        return interaction.editReply({
          content: '❌ Şu an aktif bir sezon yok. `/season baslat` ile yeni sezon oluşturabilirsin.',
        });
      }

      const started = Math.floor(new Date(current.started_at).getTime() / 1000);
      const gunSayisi = Math.floor((Date.now() - new Date(current.started_at).getTime()) / 86400000);

      // Bu sezondaki katılımcı sayısı (puan > 0 olan)
      const catRes = await pool.query(`
        SELECT COUNT(*) AS cnt FROM activity
        WHERE guild_id = $1 AND (
          COALESCE(message_score,0) + COALESCE(voice_score,0) + COALESCE(task_points,0) +
          COALESCE(mandatory_task_points,0) + COALESCE(responsibility_points,0) + COALESCE(manual_points,0)
        ) > 0
      `, [guildId]);

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle(`🏟️ Aktif Sezon — ${current.name}`)
          .setColor(0x9966ff)
          .addFields(
            { name: '🆔 Sezon ID',    value: `${current.id}`,        inline: true },
            { name: '📅 Başlangıç',   value: `<t:${started}:D>`,     inline: true },
            { name: '⏳ Süre',        value: `${gunSayisi} gün`,      inline: true },
            { name: '👥 Aktif Kişi',  value: `${catRes.rows[0].cnt}`, inline: true },
          )
          .setTimestamp()
        ],
      });
    }

    // ── gecmis ────────────────────────────────────────────────────
    if (sub === 'gecmis') {
      const seasons = await listSeasons(guildId);

      if (!seasons.length) {
        return interaction.editReply({ content: '❌ Henüz hiç sezon yok.' });
      }

      const lines = seasons.map(s => {
        const started = Math.floor(new Date(s.started_at).getTime() / 1000);
        const ended   = s.ended_at ? Math.floor(new Date(s.ended_at).getTime() / 1000) : null;
        const durum   = s.is_active ? '🟢 Aktif' : '⚫ Bitti';
        return `**#${s.id} ${s.name}** ${durum}\n` +
               `└ <t:${started}:D>${ended ? ` → <t:${ended}:D>` : ' → devam ediyor'}`;
      }).join('\n\n');

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('📚 Sezon Geçmişi')
          .setColor(0x7289da)
          .setDescription(lines)
          .setFooter({ text: '/season arsiv <sezon_id> ile detaylı sıralama görebilirsin' })
          .setTimestamp()
        ],
      });
    }

    // ── arsiv ─────────────────────────────────────────────────────
    if (sub === 'arsiv') {
      const seasonId = interaction.options.getInteger('sezon_id');

      const seasonRes = await pool.query(
        `SELECT * FROM seasons WHERE id = $1 AND guild_id = $2`,
        [seasonId, guildId]
      );

      if (!seasonRes.rows.length) {
        return interaction.editReply({ content: `❌ #${seasonId} ID'li sezon bulunamadı.` });
      }

      const season = seasonRes.rows[0];

      if (season.is_active) {
        return interaction.editReply({ content: '❌ Bu sezon hâlâ aktif. Arşiv yalnızca biten sezonlar için görüntülenebilir.' });
      }

      const topRows = await getSeasonLeaderboard(seasonId, guildId);
      const embed   = buildSeasonArchiveEmbed(season, topRows);

      return interaction.editReply({ embeds: [embed] });
    }
  },
};

const {
  SlashCommandBuilder, EmbedBuilder, MessageFlags,
} = require('discord.js');
const {
  setCfg, getCfg,
  addRole, removeRole, getRoles,
  getUserStatus, generateWeeklyReport, generateSystemPanel, warnUser,
} = require('../../utils/roleSystem');
const { pool } = require('../../utils/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staff')
    .setDescription('Yetkili sıralaması ve görev sistemi yönetimi')

    // ── Setup ─────────────────────────────────────────────────
    .addSubcommand(s => s.setName('setup')
      .setDescription('Yetkili sistemini kur')
      .addChannelOption(o => o.setName('log').setDescription('Rapor ve uyarı log kanalı').setRequired(true))
    )

    // ── Role management ───────────────────────────────────────
    .addSubcommand(s => s.setName('role-add')
      .setDescription('Yetkili sistemine rol ekle')
      .addRoleOption(o => o.setName('role').setDescription('Discord rolü').setRequired(true))
      .addIntegerOption(o => o.setName('xp').setDescription('Terfi için gereken XP').setRequired(true))
      .addIntegerOption(o => o.setName('limit').setDescription('Haftalık isteğe bağlı görev limiti').setRequired(true))
      .addNumberOption(o => o.setName('multiplier').setDescription('XP çarpanı (örn: 1.5)').setRequired(true))
      .addIntegerOption(o => o.setName('weekly').setDescription('Dönem başına zorunlu görev sayısı').setRequired(true))
      .addIntegerOption(o => o.setName('period').setDescription('Zorunlu görev dönemi (hafta)').setRequired(false))
      .addIntegerOption(o => o.setName('position').setDescription('Rol sıra konumu (1 = en düşük)').setRequired(false))
    )
    .addSubcommand(s => s.setName('role-remove')
      .setDescription('Yetkili sisteminden rol kaldır')
      .addRoleOption(o => o.setName('role').setDescription('Kaldırılacak rol').setRequired(true))
    )
    .addSubcommand(s => s.setName('roles').setDescription('Yetkili sistemindeki tüm rolleri listele'))

    // ── Status / Report / Warn ────────────────────────────────
    .addSubcommand(s => s.setName('status')
      .setDescription('Bir kullanıcının yetkili durumunu göster')
      .addUserOption(o => o.setName('user').setDescription('Kullanıcı (boş = kendin)').setRequired(false))
    )
    .addSubcommand(s => s.setName('report').setDescription('Haftalık raporu manuel olarak oluştur'))
    .addSubcommand(s => s.setName('panel')
      .setDescription('Yetkili sistemi genel bakış panelini gönder')
      .addChannelOption(o => o.setName('channel').setDescription('Hedef kanal (boş = mevcut kanal)').setRequired(false))
    )
    .addSubcommand(s => s.setName('warn')
      .setDescription('Kullanıcıyı manuel olarak uyar')
      .addUserOption(o => o.setName('user').setDescription('Uyarılacak kullanıcı').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Uyarı sebebi').setRequired(false))
    )
    .addSubcommand(s => s.setName('promotions')
      .setDescription('Terfi taleplerini listele')
      .addStringOption(o => o
        .setName('filter')
        .setDescription('Durum filtresi')
        .addChoices(
          { name: '⏳ Bekliyor',    value: 'bekliyor'    },
          { name: '✅ Onaylandı',   value: 'onaylandi'   },
          { name: '❌ Reddedildi',  value: 'reddedildi'  },
          { name: '🔄 Hepsi',       value: 'hepsi'       },
        )
        .setRequired(false)
      )
    ),
  category: 'yonetici',

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // ── setup ─────────────────────────────────────────────────
    if (sub === 'setup') {
      const log = interaction.options.getChannel('log');
      await setCfg(guildId, 'rs_log_channel', log.id);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x44cc88)
          .setTitle('✅ Yetkili Sistemi Kuruldu')
          .addFields({ name: '📋 Log Kanalı', value: `${log}`, inline: true })
          .setDescription([
            '**Sonraki adımlar:**',
            '1. `/staff role-add` ile rolleri ekle (en düşükten en yükseğe)',
            '2. Görev panelinden görev oluştur ve rollere ata',
            '3. Görevler tamamlandığında XP otomatik hesaplanır',
          ].join('\n'))
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── role-add ──────────────────────────────────────────────
    if (sub === 'role-add') {
      const role      = interaction.options.getRole('role');
      const xp        = interaction.options.getInteger('xp');
      const limit     = interaction.options.getInteger('limit');
      const multiplier = interaction.options.getNumber('multiplier');
      const weekly    = interaction.options.getInteger('weekly');
      const period    = interaction.options.getInteger('period') ?? 1;
      const position  = interaction.options.getInteger('position') ?? 1;

      await addRole(guildId, role.id, role.name, {
        xpRequired: xp, responsibilityLimit: limit,
        multiplier, weeklyTasksRequired: weekly,
        taskPeriodWeeks: period, position,
      });

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x44cc88)
          .setTitle('✅ Rol Eklendi')
          .addFields(
            { name: '🎭 Rol',              value: `<@&${role.id}>`,                   inline: true },
            { name: '⭐ Gereken XP',       value: `${xp}`,                            inline: true },
            { name: '🔢 Görev Limiti',     value: `Haftada ${limit} görev`,           inline: true },
            { name: '✖️ Çarpan',           value: `${multiplier}x`,                   inline: true },
            { name: '📋 Zorunlu Görev',    value: `${weekly} / ${period} haftada`,    inline: true },
            { name: '📊 Konum',            value: `${position}`,                      inline: true },
          )],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── role-remove ───────────────────────────────────────────
    if (sub === 'role-remove') {
      const role = interaction.options.getRole('role');
      await removeRole(guildId, role.id);
      return interaction.reply({ content: `✅ <@&${role.id}> sistemden kaldırıldı.`, flags: MessageFlags.Ephemeral });
    }

    // ── roles ─────────────────────────────────────────────────
    if (sub === 'roles') {
      const roles = await getRoles(guildId);
      if (!roles.length) return interaction.reply({ content: '❌ Henüz hiç rol eklenmemiş.', flags: MessageFlags.Ephemeral });

      const embed = new EmbedBuilder()
        .setColor(0x9966ff)
        .setTitle('🎭 Yetkili Sistemi Rolleri')
        .setDescription(roles.map(r =>
          `**${r.position}.** <@&${r.role_id}> — **${r.xp_required} XP** · Limit: ${r.responsibility_limit} · Çarpan: ${r.xp_multiplier}x · Zorunlu: ${r.weekly_tasks_required}/${r.task_period_weeks}hft`
        ).join('\n'));

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── status ────────────────────────────────────────────────
    if (sub === 'status') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const target = interaction.options.getUser('user') ?? interaction.user;
      const status = await getUserStatus(guildId, target.id, interaction.guild);

      if (!status) {
        return interaction.editReply({ content: `❌ **${target.username}** için kayıt bulunamadı.` });
      }

      const { user, roleData, scoreBreakdown, weekCompletions, mandatoryDone, weekTotal, weekXP } = status;
      const limit = roleData?.responsibility_limit ?? '?';

      const embed = new EmbedBuilder()
        .setColor(0x9966ff)
        .setTitle(`📊 ${target.username} — Yetkili Durumu`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name: '🎭 Mevcut Rol',        value: roleData ? `<@&${roleData.role_id}>` : '*Sistemde yok*', inline: true },
          { name: '🔥 Streak',            value: `${user.streak ?? 0} hafta`,                             inline: true },
          { name: '⚠️ Uyarı',            value: `${user.warning_count ?? 0}`,                            inline: true },
          { name: '📋 Zorunlu Görev',     value: mandatoryDone ? '✅ Tamamlandı' : '❌ Bekliyor',        inline: true },
          { name: '📊 Bu Hafta',          value: `${weekTotal}/${limit} görev · ${weekXP} XP`,           inline: true },
          { name: '​',                    value: '​',                                                      inline: true },
          { name: '💬 Mesaj',            value: `${scoreBreakdown.mesaj}`,       inline: true },
          { name: '🎙️ Ses',              value: `${scoreBreakdown.ses}`,         inline: true },
          { name: '⚠️ Zorunlu',          value: `${scoreBreakdown.zorunlu}`,     inline: true },
          { name: '🎯 İsteğe Bağlı',     value: `${scoreBreakdown.gorev}`,       inline: true },
          { name: '📌 Sorumluluk',        value: `${scoreBreakdown.sorumluluk}`,  inline: true },
          { name: '⭐ Manuel',            value: `${scoreBreakdown.manuel}`,      inline: true },
          { name: '🏆 Toplam',            value: `**${scoreBreakdown.toplam}**`,  inline: true },
          { name: '​',                    value: '​',                              inline: true },
        );

      if (weekCompletions.length) {
        embed.addFields({
          name: '📌 Bu Haftaki Görevler',
          value: weekCompletions.map(c => `**${c.type_name}**: ${c.count}x · ${c.xp} XP`).join('\n'),
          inline: false,
        });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // ── report ────────────────────────────────────────────────
    if (sub === 'report') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await generateWeeklyReport(interaction.client, guildId);
        return interaction.editReply({ content: '✅ Haftalık rapor log kanalına gönderildi.' });
      } catch (err) {
        console.error('[staff:report]', err);
        return interaction.editReply({ content: `❌ Rapor oluşturulurken hata oluştu: ${err.message}` });
      }
    }

    // ── panel ─────────────────────────────────────────────────
    if (sub === 'panel') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;
        const embeds = await generateSystemPanel(interaction.client, guildId, interaction.guild);
        await targetChannel.send({ embeds });
        return interaction.editReply({ content: `✅ Yetkili paneli ${targetChannel} kanalına gönderildi.` });
      } catch (err) {
        console.error('[staff:panel]', err);
        return interaction.editReply({ content: `❌ Panel oluşturulurken hata oluştu: ${err.message}` });
      }
    }

    // ── warn ──────────────────────────────────────────────────
    if (sub === 'warn') {
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') ?? 'Manuel uyarı';
      const count  = await warnUser(guildId, target.id, target.username, reason);

      const logId = await getCfg(guildId, 'rs_log_channel');
      if (logId) {
        const logCh = interaction.client.channels.cache.get(logId);
        await logCh?.send({
          embeds: [new EmbedBuilder()
            .setColor(0xff9900)
            .setTitle(`⚠️ Manuel Uyarı #${count}`)
            .addFields(
              { name: '👤 Kullanıcı', value: `<@${target.id}>`,           inline: true },
              { name: '⚠️ Uyarı',    value: `${count}`,                   inline: true },
              { name: '👮 Veren',     value: `<@${interaction.user.id}>`, inline: true },
              { name: '📝 Sebep',     value: reason,                       inline: false },
            ).setTimestamp()],
        }).catch(() => {});
      }

      return interaction.reply({
        content: `✅ **${target.username}** uyarıldı. (Toplam: ${count} uyarı)`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── promotions ────────────────────────────────────────────
    if (sub === 'promotions') {
      const filter = interaction.options.getString('filter') ?? 'bekliyor';

      const filterParams = [guildId];
      const whereClause  = filter === 'hepsi' ? '' : (filterParams.push(filter), `AND status = $${filterParams.length}`);
      const rows = (await pool.query(`
        SELECT * FROM promotion_requests
        WHERE guild_id = $1 ${whereClause}
        ORDER BY requested_at DESC LIMIT 25
      `, filterParams)).rows;

      if (!rows.length) {
        const label = { bekliyor: 'Bekleyen', onaylandi: 'Onaylanan', reddedildi: 'Reddedilen', hepsi: 'Hiçbir' }[filter] ?? filter;
        return interaction.reply({
          content: `📭 **${label}** terfi talebi bulunamadı.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const statusEmoji = { bekliyor: '⏳', onaylandi: '✅', reddedildi: '❌' };
      const lines = rows.map(r => {
        const emoji = statusEmoji[r.status] ?? '❓';
        const ts    = Math.floor(new Date(r.requested_at).getTime() / 1000);
        let line = `${emoji} **#${r.id}** <@${r.user_id}> → <@&${r.target_role_id}> — <t:${ts}:R>`;
        if (r.resolved_by) line += `\n┗ ${r.status === 'onaylandi' ? 'Onaylayan' : 'Reddeden'}: <@${r.resolved_by}>`;
        return line;
      }).join('\n\n');

      const colorMap = { bekliyor: 0xffcc00, onaylandi: 0x44cc88, reddedildi: 0xff4444, hepsi: 0x9966ff };
      const titleMap = { bekliyor: 'Bekleyen', onaylandi: 'Onaylanan', reddedildi: 'Reddedilen', hepsi: 'Tüm' };

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(colorMap[filter] ?? 0x9966ff)
          .setTitle(`🎉 Terfi Talepleri — ${titleMap[filter] ?? filter}`)
          .setDescription(lines)
          .setFooter({ text: `${rows.length} talep` })
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

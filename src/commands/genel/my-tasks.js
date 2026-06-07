const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool } = require('../../utils/database');
const { checkRequirements, parseRequirements } = require('../../utils/taskManager');

const STATUS_EMOJI = { bekliyor: '⏳', 'onay_bekleniyor': '🕐', devam: '🔄', tamamlandı: '✅', iptal: '❌' };
const REC_LABEL    = { gunluk: '📅 Günlük', haftalik: '📅 Haftalık', aylik: '📅 Aylık' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-tasks')
    .setDescription('Sana atanmış görevleri listeler')
    .addStringOption(opt =>
      opt.setName('durum')
        .setDescription('Durum filtresi')
        .setRequired(false)
        .addChoices(
          { name: '⏳ Bekliyor',    value: 'bekliyor'   },
          { name: '✅ Tamamlandı',  value: 'tamamlandı' },
          { name: '🔄 Hepsi',       value: 'hepsi'      },
        )
    ),
  category: 'genel',

  async execute(interaction) {
    const guildId = interaction.guild.id;
    const userId  = interaction.user.id;
    const durum   = interaction.options.getString('durum') ?? 'bekliyor';

    const queryParams  = [guildId, userId];
    // bekliyor filtresi onay_bekleniyor'u da kapsar (kullanıcı için ikisi de "aktif")
    const statusFilter = durum === 'hepsi'
      ? ''
      : durum === 'bekliyor'
        ? `AND ta.status IN ('bekliyor', 'onay_bekleniyor')`
        : (queryParams.push(durum), `AND ta.status = $${queryParams.length}`);

    const res = await pool.query(`
      SELECT
        t.id, t.title, t.points, t.priority, t.due_date,
        t.recurrence, t.is_mandatory, t.category, t.is_private,
        t.requirements, t.start_date,
        ta.status AS my_status, ta.assigned_at, ta.completed_at
      FROM tasks t
      JOIN task_assignments ta ON ta.task_id = t.id
      WHERE t.guild_id = $1 AND ta.user_id = $2
        AND t.status != 'iptal'
        ${statusFilter}
      ORDER BY
        CASE ta.status WHEN 'bekliyor' THEN 0 WHEN 'devam' THEN 1 ELSE 2 END,
        t.created_at DESC
      LIMIT 20
    `, queryParams);

    if (!res.rows.length) {
      const mesaj = durum === 'bekliyor'
        ? '❌ Bekleyen görevin yok.'
        : '❌ Görev bulunamadı.';
      return interaction.reply({ content: mesaj, flags: MessageFlags.Ephemeral });
    }

    const durumLabel = { bekliyor: 'Aktif', tamamlandı: 'Tamamlanan', hepsi: 'Tüm' }[durum] ?? 'Tüm';

    const embed = new EmbedBuilder()
      .setTitle(`📋 ${durumLabel} Görevlerim`)
      .setColor(0x9966ff)
      .setTimestamp();

    for (const t of res.rows) {
      const turStr     = t.is_mandatory ? '⚠️ Zorunlu' : '🎯 İsteğe Bağlı';
      const recStr     = t.recurrence ? ` · ${REC_LABEL[t.recurrence] ?? t.recurrence}` : '';
      const dueStr     = t.due_date ? ` · ⏰ ${t.due_date}` : '';
      const catStr     = t.category ? ` · 📂 ${t.category}` : '';
      const privateStr = (t.is_private && t.my_status === 'bekliyor') ? ' · 🔒 Özel' : '';

      let extraLine = '';
      if (t.my_status === 'tamamlandı' && t.completed_at) {
        const ts = Math.floor(new Date(t.completed_at).getTime() / 1000);
        extraLine = `\n✅ Tamamlandı: <t:${ts}:R>`;
      } else if (t.my_status === 'onay_bekleniyor') {
        extraLine = `\n🕐 Admin onayı bekleniyor…`;
      }

      // Bekleyen görevlerde ilerleme göster
      let progressLine = '';
      if (t.my_status === 'bekliyor') {
        const req = parseRequirements('');
        // DB'den requirements JSON olarak geliyor
        const taskReq = t.requirements ?? {};
        if (Object.keys(taskReq).length > 0) {
          const fakeAssignment = { assigned_at: t.assigned_at };
          const fakeTask = {
            requirements: taskReq,
            is_mandatory: t.is_mandatory,
            start_date: t.start_date ?? null,
          };
          const result = await checkRequirements(guildId, userId, fakeAssignment, fakeTask).catch(() => null);
          if (result?.progress?.length) {
            progressLine = '\n' + result.progress.join('\n');
          }
        }
      }

      embed.addFields({
        name: `${STATUS_EMOJI[t.my_status] ?? '⏳'} #${t.id} — ${t.title}`,
        value: `${turStr} · 🏆 ${t.points ?? 25}p${dueStr}${recStr}${catStr}${privateStr}${extraLine}${progressLine}`,
        inline: false,
      });
    }

    const bekleyenCount = res.rows.filter(r => r.my_status === 'bekliyor').length;
    const onayBekleyenCount = res.rows.filter(r => r.my_status === 'onay_bekleniyor').length;
    const footerParts = [];
    if (bekleyenCount > 0) footerParts.push(`${bekleyenCount} bekleyen görev`);
    if (onayBekleyenCount > 0) footerParts.push(`${onayBekleyenCount} onay bekliyor`);
    if (footerParts.length > 0 && durum !== 'tamamlandı') {
      embed.setFooter({ text: footerParts.join(' · ') });
    }

    // Butonlar:
    // - Özel görev + bekliyor (onay_bekleniyor DEĞİL) → "Tamamla" butonu
    // - İsteğe bağlı + bekliyor (onay_bekleniyor DEĞİL) → "Vazgeç" butonu
    const aktifGorevler = res.rows.filter(r => r.my_status === 'bekliyor').slice(0, 5);
    const components = aktifGorevler.map(t => {
      const btns = [];
      if (t.is_private) {
        btns.push(
          new ButtonBuilder()
            .setCustomId(`mytask_complete_${t.id}`)
            .setLabel(`✅ Tamamla`)
            .setStyle(ButtonStyle.Success)
        );
      }
      // Sadece isteğe bağlı görevlerde Vazgeç butonu göster
      if (!t.is_mandatory) {
        btns.push(
          new ButtonBuilder()
            .setCustomId(`mytask_vazgec_${t.id}`)
            .setLabel(`🚪 Vazgeç`)
            .setStyle(ButtonStyle.Danger)
        );
      }
      if (!btns.length) return null;
      return new ActionRowBuilder().addComponents(...btns);
    }).filter(Boolean);

    return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
  },
};

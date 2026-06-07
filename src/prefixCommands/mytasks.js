const { EmbedBuilder } = require('discord.js');
const { pool } = require('../utils/database');
const { checkRequirements } = require('../utils/taskManager');

const STATUS_EMOJI = { bekliyor: '⏳', onay_bekleniyor: '🕐', devam: '🔄', tamamlandı: '✅', iptal: '❌' };
const REC_LABEL    = { gunluk: '📅 Günlük', haftalik: '📅 Haftalık', aylik: '📅 Aylık' };

module.exports = {
  name: 'mytasks',
  aliases: ['görevlerim', 'gorevlerim', 'tasks'],
  cooldown: 10,
  description: 'Aktif görevlerini listeler',
  async execute(message, args) {
    const guildId = message.guild.id;
    const userId  = message.author.id;

    const res = await pool.query(`
      SELECT
        t.id, t.title, t.points, t.due_date,
        t.recurrence, t.is_mandatory, t.category,
        t.requirements, t.start_date,
        ta.status AS my_status, ta.assigned_at
      FROM tasks t
      JOIN task_assignments ta ON ta.task_id = t.id
      WHERE t.guild_id = $1 AND ta.user_id = $2
        AND t.status != 'iptal'
        AND ta.status IN ('bekliyor', 'onay_bekleniyor')
      ORDER BY
        CASE ta.status WHEN 'bekliyor' THEN 0 ELSE 1 END,
        t.created_at DESC
      LIMIT 10
    `, [guildId, userId]);

    if (!res.rows.length) {
      return message.reply('❌ Bekleyen görevin yok.');
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Aktif Görevlerim')
      .setColor(0x9966ff)
      .setTimestamp();

    for (const t of res.rows) {
      const turStr = t.is_mandatory ? '⚠️ Zorunlu' : '🎯 İsteğe Bağlı';
      const recStr = t.recurrence ? ` · ${REC_LABEL[t.recurrence] ?? t.recurrence}` : '';
      const dueStr = t.due_date ? ` · ⏰ ${t.due_date}` : '';

      let progressLine = '';
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

      embed.addFields({
        name: `${STATUS_EMOJI[t.my_status] ?? '⏳'} #${t.id} — ${t.title}`,
        value: `${turStr} · 🏆 ${t.points ?? 25}p${dueStr}${recStr}${progressLine}`,
        inline: false,
      });
    }

    embed.setFooter({ text: `${res.rows.length} aktif görev` });

    await message.reply({ embeds: [embed] });
  },
};

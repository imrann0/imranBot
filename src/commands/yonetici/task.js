const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const {
  setConfig, getConfig, getAllTasks, getTaskProgress, getTask, updateTask,
  buildTaskEmbed, buildTaskButtons,
  getTemplates, deleteTemplate,
  addCategory, removeCategory, getCategories,
  checkXpLimit, checkCategoryCap,
  checkRequirements, formatRequirements,
} = require('../../utils/taskManager');
const { pool } = require('../../utils/database');
const { addTaskPoints, addMandatoryTaskPoints } = require('../../utils/activityTracker');
const { calcTaskXP, completeMandatoryFromTask, checkPromotion } = require('../../utils/roleSystem');

const PRIORITY_POINTS = { yüksek: 50, orta: 25, düşük: 10 };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('task')
    .setDescription('Görev sistemini yönetir')
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Görev panelini kur')
        .addChannelOption(opt => opt.setName('panel').setDescription('Panel kanalı').setRequired(true))
        .addChannelOption(opt => opt.setName('tasks').setDescription('Görev kanalı').setRequired(true))
        .addChannelOption(opt => opt.setName('log').setDescription('Admin log kanalı (isteğe bağlı)').setRequired(false))
        .addBooleanOption(opt => opt.setName('onay').setDescription('Görev tamamlamak için admin onayı zorunlu olsun mu?').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Görevleri listele ve filtrele')
        .addStringOption(opt =>
          opt.setName('status').setDescription('Durum filtresi').setRequired(false)
            .addChoices(
              { name: '⏳ Bekliyor', value: 'bekliyor' },
              { name: '🔄 Devam Ediyor', value: 'devam' },
              { name: '✅ Tamamlandı', value: 'tamamlandı' },
              { name: '❌ İptal', value: 'iptal' },
            )
        )
        .addStringOption(opt => opt.setName('arama').setDescription('Başlıkta kelime ara').setRequired(false))
        .addStringOption(opt =>
          opt.setName('oncelik').setDescription('Öncelik filtresi').setRequired(false)
            .addChoices(
              { name: '🔴 Yüksek', value: 'yüksek' },
              { name: '🟡 Orta',   value: 'orta' },
              { name: '🟢 Düşük',  value: 'düşük' },
            )
        )
        .addStringOption(opt => opt.setName('kategori').setDescription('Kategori filtresi').setRequired(false))
        .addUserOption(opt => opt.setName('kullanici').setDescription('Belirli bir kullanıcının görevleri').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('edit')
        .setDescription('Görevi düzenle')
        .addIntegerOption(opt => opt.setName('id').setDescription('Görev ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('complete')
        .setDescription('Admin olarak görevi tamamla')
        .addIntegerOption(opt => opt.setName('gorev_id').setDescription('Görev ID').setRequired(true))
        .addUserOption(opt => opt.setName('kullanici').setDescription('Tamamlayan kullanıcı').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('templates')
        .setDescription('Kayıtlı şablonları listele ve yönet')
    )
    .addSubcommand(sub =>
      sub.setName('kategori-ekle')
        .setDescription('Görev kategorisi ekle')
        .addStringOption(o => o.setName('isim').setDescription('Kategori adı (örn: partner, etkinlik)').setRequired(true))
        .addIntegerOption(o => o.setName('kap').setDescription('Kullanıcı başına toplam maksimum tamamlama').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('kategori-kaldir')
        .setDescription('Görev kategorisini kaldır')
        .addStringOption(o => o.setName('isim').setDescription('Kategori adı').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('kategoriler')
        .setDescription('Görev kategorilerini listele')
    )
    .addSubcommand(sub =>
      sub.setName('forcereassign')
        .setDescription('Aktif görevlere eksik kullanıcıları yeniden ata')
        .addIntegerOption(opt => opt.setName('id').setDescription('Görev ID (boş = tüm aktif görevler)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('progress')
        .setDescription('Görevdeki tüm kullanıcıların ilerlemesini göster')
        .addIntegerOption(opt => opt.setName('id').setDescription('Görev ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('delete')
        .setDescription('Görevi iptal eder ve tüm atamalardan kaldırır')
        .addIntegerOption(opt => opt.setName('id').setDescription('Görev ID').setRequired(true))
    ),
  category: 'yonetici',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    const guildId = interaction.guild.id;

    // ── setup ─────────────────────────────────────────────────
    if (sub === 'setup') {
      const panelChannel = interaction.options.getChannel('panel');
      const tasksChannel = interaction.options.getChannel('tasks');
      const logChannel   = interaction.options.getChannel('log');
      const onayZorunlu  = interaction.options.getBoolean('onay');
      await setConfig(guildId, 'task_panel_channel', panelChannel.id);
      await setConfig(guildId, 'task_tasks_channel', tasksChannel.id);
      if (logChannel)    await setConfig(guildId, 'task_log_channel', logChannel.id);
      if (onayZorunlu !== null) await setConfig(guildId, 'task_require_approval', String(onayZorunlu));

      const panelEmbed = new EmbedBuilder()
        .setTitle('📋 Görev Yönetim Paneli')
        .setDescription('Yeni bir görev oluşturmak için aşağıdaki butona tıkla.')
        .setColor(0x9966ff).setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('task_create').setLabel('Görev Oluştur').setEmoji('➕').setStyle(ButtonStyle.Primary)
      );

      await panelChannel.send({ embeds: [panelEmbed], components: [row] });
      const extras = [
        logChannel   ? `📋 Log kanalı: ${logChannel}` : null,
        onayZorunlu !== null ? `✋ Admin onayı: **${onayZorunlu ? 'zorunlu' : 'kapalı'}**` : null,
      ].filter(Boolean).join(' · ');
      return interaction.reply({
        content: `✅ Panel ${panelChannel} kanalına kuruldu. Görevler ${tasksChannel} kanalına atılacak.${extras ? `\n${extras}` : ''}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── list ──────────────────────────────────────────────────
    if (sub === 'list') {
      const status     = interaction.options.getString('status');
      const arama      = interaction.options.getString('arama');
      const oncelik    = interaction.options.getString('oncelik');
      const kategori   = interaction.options.getString('kategori');
      const targetUser = interaction.options.getUser('kullanici');
      const tasks = await getAllTasks(guildId, status, targetUser?.id ?? null, { search: arama, category: kategori, priority: oncelik });

      if (!tasks.length) {
        return interaction.reply({ content: '❌ Görev bulunamadı.', flags: MessageFlags.Ephemeral });
      }

      const statusEmoji = { bekliyor: '⏳', devam: '🔄', tamamlandı: '✅', iptal: '❌' };
      const prioEmoji   = { yüksek: '🔴', orta: '🟡', düşük: '🟢' };
      const filterParts = [
        status   ? status : null,
        oncelik  ? prioEmoji[oncelik] + ' ' + oncelik : null,
        kategori ? `📂 ${kategori}` : null,
        arama    ? `🔍 "${arama}"` : null,
      ].filter(Boolean).join(' · ');
      const title = targetUser
        ? `📋 ${targetUser.username} — Görevleri${filterParts ? ` (${filterParts})` : ''}`
        : `📋 Görevler${filterParts ? ` — ${filterParts}` : ''}`;

      const embed = new EmbedBuilder().setTitle(title).setColor(0x9966ff).setTimestamp();

      for (const t of tasks.slice(0, 15)) {
        const rec  = t.recurrence ? ` · 🔁 ${t.recurrence}` : '';
        const cat  = t.category   ? ` · 📂 ${t.category}` : '';
        const prio = prioEmoji[t.priority] ?? '📌';
        embed.addFields({
          name: `${statusEmoji[t.status] ?? '📌'} #${t.id} — ${t.title}`,
          value: `${prio} ⏰ ${t.due_date ?? 'Belirtilmedi'} · 🏆 ${t.points ?? 25}p · ✍️ ${t.created_by_username}${rec}${cat}`,
          inline: false,
        });
      }

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── edit ──────────────────────────────────────────────────
    if (sub === 'edit') {
      const taskId = interaction.options.getInteger('id');
      const task = await getTask(guildId, taskId);
      if (!task) return interaction.reply({ content: `❌ Görev #${taskId} bulunamadı.`, flags: MessageFlags.Ephemeral });
      if (['tamamlandı', 'iptal'].includes(task.status)) {
        return interaction.reply({ content: `❌ Tamamlanmış veya iptal edilmiş görev düzenlenemez.`, flags: MessageFlags.Ephemeral });
      }

      const PRIO = { yüksek: '🔴 Yüksek', orta: '🟡 Orta', düşük: '🟢 Düşük' };
      const reqObj = task.requirements ?? {};
      const reqParts = [];
      if (reqObj.voice_minutes)     reqParts.push(`ses:${reqObj.voice_minutes}`);
      if (reqObj.messages)          reqParts.push(`mesaj:${reqObj.messages}`);
      if (reqObj.partnership_count) reqParts.push(`partnerlik:${reqObj.partnership_count}`);
      const roles = (task.assigned_role_ids ?? []).map(r => `<@&${r.id ?? r}>`).join(', ') || '*Yok*';

      const embed = new EmbedBuilder()
        .setTitle(`✏️ Görev #${taskId} — Düzenle`)
        .setColor(0x9966ff)
        .addFields(
          { name: '📝 Başlık', value: task.title, inline: false },
          { name: '📄 Açıklama', value: task.description || '*Yok*', inline: false },
          { name: '📅 Başlangıç', value: task.start_date || '*Yok*', inline: true },
          { name: '📅 Bitiş', value: task.due_date || '*Yok*', inline: true },
          { name: '🎯 Gereksinimler', value: reqParts.join(', ') || '*Yok*', inline: true },
          { name: '⚡ Öncelik', value: PRIO[task.priority] ?? task.priority, inline: true },
          { name: '💰 Puan', value: `${task.points ?? 25}`, inline: true },
          { name: '🎭 Roller', value: roles, inline: false },
          { name: '⚙️ Diğer', value: `Zorunlu: ${task.is_mandatory ? '✅' : '❌'} · Gizli: ${task.is_private ? '✅' : '❌'} · XP Limiti: ${task.xp_limit ?? 'Sınırsız'} · Kategori: ${task.category || '*Yok*'}`, inline: false },
        )
        .setFooter({ text: 'Düzenlemek istediğin alana tıkla' });

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`task_edit_text_${taskId}`).setLabel('Başlık/Açıklama').setEmoji('📝').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`task_edit_dates_${taskId}`).setLabel('Tarihler').setEmoji('📅').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`task_edit_req_${taskId}`).setLabel('Gereksinimler').setEmoji('🎯').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`task_edit_priority_${taskId}`).setLabel('Öncelik').setEmoji('⚡').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`task_edit_points_${taskId}`).setLabel('Puan').setEmoji('💰').setStyle(ButtonStyle.Secondary),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`task_edit_roles_${taskId}`).setLabel('Roller').setEmoji('🎭').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`task_edit_other_${taskId}`).setLabel('Diğer').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
      );

      return interaction.reply({ embeds: [embed], components: [row1, row2], flags: MessageFlags.Ephemeral });
    }

    // ── complete ──────────────────────────────────────────────
    if (sub === 'complete') {
      const { getAssignment, updateAssignment, getTaskProgress } = require('../../utils/taskManager');
      const taskId = interaction.options.getInteger('gorev_id');
      const target = interaction.options.getUser('kullanici');
      const task = await getTask(guildId, taskId);
      if (!task) return interaction.reply({ content: `❌ Görev #${taskId} bulunamadı.`, flags: MessageFlags.Ephemeral });
      if (['tamamlandı', 'iptal'].includes(task.status)) {
        return interaction.reply({ content: `❌ Görev zaten **${task.status}**.`, flags: MessageFlags.Ephemeral });
      }
      const assignment = await getAssignment(taskId, target.id);
      if (!assignment) return interaction.reply({ content: `❌ ${target.username} bu göreve atanmamış.`, flags: MessageFlags.Ephemeral });
      if (assignment.status === 'tamamlandı') return interaction.reply({ content: `❌ ${target.username} zaten tamamladı.`, flags: MessageFlags.Ephemeral });

      const basePoints = task.points ?? PRIORITY_POINTS[task.priority] ?? 25;
      const uid = target.id;
      const uname = target.username;

      // Bug fix: XP limit kontrolü güncelleme öncesi yapılmalı
      const xpLimitResult = await checkXpLimit(task, uid).catch(() => ({ limited: false, count: 0 }));

      await updateAssignment(taskId, uid, { status: 'tamamlandı', completed_at: new Date().toISOString() });

      let pointMsg = '';
      if (task.is_mandatory) {
        // Zorunlu görev: mandatory puan havuzu
        if (!xpLimitResult.limited) {
          const { finalPoints } = await calcTaskXP(guildId, interaction.guild, uid, basePoints).catch(() => ({ finalPoints: basePoints }));
          await addMandatoryTaskPoints(guildId, uid, uname, finalPoints);
          await completeMandatoryFromTask(guildId, uid, uname).catch(() => null);
          pointMsg = `+${finalPoints} zorunlu görev puanı`;
        } else {
          pointMsg = 'Tamamlama limiti doldu, puan verilmedi';
        }
      } else {
        // İsteğe bağlı: tüm türler görev puanı verir
        if (xpLimitResult.limited) {
          pointMsg = `Tamamlama limiti doldu (${xpLimitResult.count}/${xpLimitResult.limit} kez) — puan verilmedi`;
        } else {
          let capped = false;
          if (task.category) {
            const capResult = await checkCategoryCap(guildId, uid, task.category).catch(() => ({ capped: false }));
            if (capResult.capped) {
              capped = true;
              pointMsg = `${task.category} kategorisi doldu — puan verilmedi`;
            }
          }
          if (!capped) {
            const { finalPoints, overLimit } = await calcTaskXP(guildId, interaction.guild, uid, basePoints).catch(() => ({ finalPoints: basePoints, overLimit: false }));
            await addTaskPoints(guildId, uid, uname, finalPoints);
            pointMsg = `+${finalPoints} puan${overLimit ? ' (%60 — haftalık limit aşıldı)' : ''}`;
          }
        }
      }

      if (task.is_mandatory) {
        const allAssignments = await getTaskProgress(taskId);
        if (allAssignments.every(a => a.status === 'tamamlandı')) await updateTask(guildId, taskId, { status: 'tamamlandı' });
      }

      const updated = await getTask(guildId, taskId);
      const embed = await buildTaskEmbed(updated);
      const buttons = buildTaskButtons(updated.id, updated.status, updated);
      if (updated.message_id && updated.channel_id) {
        try {
          const ch = interaction.client.channels.cache.get(updated.channel_id);
          const msg = await ch?.messages.fetch(updated.message_id);
          if (msg) await msg.edit({ embeds: [embed], components: buttons ? [buttons] : [] });
        } catch {}
      }

      // Terfi kontrolü — admin tamamlamada da çalışmalı
      const promoRole = await checkPromotion(guildId, interaction.guild, uid, uname).catch(() => null);

      return interaction.reply({
        content: `✅ **${uname}**, görev **#${taskId}** tamamlandı · ${pointMsg}${promoRole ? `\n🎉 Kullanıcı terfi şartlarını karşıladı → <@&${promoRole.role_id}>` : ''}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── kategori-ekle ─────────────────────────────────────────
    if (sub === 'kategori-ekle') {
      const isim = interaction.options.getString('isim').toLowerCase();
      const kap  = interaction.options.getInteger('kap');
      await addCategory(guildId, isim, kap);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x44cc88)
          .setTitle('✅ Kategori Eklendi')
          .addFields(
            { name: '📂 Kategori', value: isim,      inline: true },
            { name: '🚫 Kap',      value: `${kap}x`, inline: true },
          )
          .setDescription('Görev oluştururken bu kategoriyi seçebilirsin.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── kategori-kaldir ───────────────────────────────────────
    if (sub === 'kategori-kaldir') {
      const isim = interaction.options.getString('isim').toLowerCase();
      await removeCategory(guildId, isim);
      return interaction.reply({ content: `✅ **${isim}** kategorisi kaldırıldı.`, flags: MessageFlags.Ephemeral });
    }

    // ── kategoriler ───────────────────────────────────────────
    if (sub === 'kategoriler') {
      const cats = await getCategories(guildId);
      if (!cats.length) return interaction.reply({ content: '❌ Henüz kategori eklenmemiş. `/task kategori-ekle` ile ekle.', flags: MessageFlags.Ephemeral });
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x9966ff)
          .setTitle('📂 Görev Kategorileri')
          .setDescription(cats.map(c => `**${c.name}** — Kap: ${c.total_cap}`).join('\n'))],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── templates ─────────────────────────────────────────────
    if (sub === 'templates') {
      const templates = await getTemplates(guildId);
      if (!templates.length) {
        return interaction.reply({ content: '❌ Kayıtlı şablon yok.', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setTitle('📁 Kayıtlı Görev Şablonları')
        .setColor(0x9966ff)
        .setDescription(
          templates.map((t, i) => {
            const ts = Math.floor(new Date(t.created_at).getTime() / 1000);
            return `\`${String(i + 1).padStart(2, '0')}\` **#${t.id} ${t.name}** · ${t.type} · 🏆${t.points}p · <t:${ts}:R>`;
          }).join('\n')
        )
        .setFooter({ text: `Silmek için: /task templates → Sil butonu` });

      const deleteButtons = templates.slice(0, 5).map(t =>
        new ButtonBuilder()
          .setCustomId(`task_template_delete_${t.id}`)
          .setLabel(`#${t.id} Sil`)
          .setStyle(ButtonStyle.Danger)
      );

      const rows = [];
      for (let i = 0; i < deleteButtons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(...deleteButtons.slice(i, i + 5)));
      }

      return interaction.reply({ embeds: [embed], components: rows, flags: MessageFlags.Ephemeral });
    }

    // ── forcereassign ─────────────────────────────────────────
    if (sub === 'forcereassign') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const taskId = interaction.options.getInteger('id');
      const where  = taskId
        ? `WHERE guild_id = $1 AND id = $2 AND status IN ('bekliyor', 'devam')`
        : `WHERE guild_id = $1 AND status IN ('bekliyor', 'devam') AND recurrence IS NOT NULL`;
      const params = taskId ? [guildId, taskId] : [guildId];

      const tasks = await pool.query(`SELECT id, title, assigned_role_ids FROM tasks ${where}`, params);
      if (!tasks.rows.length) return interaction.editReply({ content: '❌ Aktif görev bulunamadı.' });

      await interaction.guild.members.fetch();

      let totalAdded = 0;
      const results = [];

      for (const task of tasks.rows) {
        const roleIds = (task.assigned_role_ids ?? []).map(r => r.id ?? r);
        if (!roleIds.length) continue;

        const members = interaction.guild.members.cache.filter(m =>
          m.roles.cache.some(r => roleIds.includes(r.id))
        );

        let added = 0;
        for (const [, member] of members) {
          const exists = await pool.query(
            `SELECT 1 FROM task_assignments WHERE task_id = $1 AND user_id = $2`,
            [task.id, member.id]
          );
          if (exists.rows.length) continue;

          await pool.query(
            `INSERT INTO task_assignments (task_id, user_id, username, assigned_at)
             VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
            [task.id, member.id, member.user.username]
          );
          added++;
          totalAdded++;
        }

        results.push(`**#${task.id} ${task.title}** → ${added} kişi eklendi`);
      }

      return interaction.editReply({
        content: `✅ Yeniden atama tamamlandı — toplam **${totalAdded}** kişi eklendi:\n${results.join('\n')}`,
      });
    }

    // ── progress ──────────────────────────────────────────────
    if (sub === 'progress') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const taskId = interaction.options.getInteger('id');
      const task   = await getTask(guildId, taskId);
      if (!task) return interaction.editReply({ content: `❌ Görev #${taskId} bulunamadı.` });

      const req    = task.requirements ?? {};
      const hasReq = Object.keys(req).length > 0;

      // Gereksinim maksimum değerlerini hesapla (yüzde için)
      const maxVoice  = req.voice_minutes     ?? 0;
      const maxMsg    = req.messages          ?? 0;
      const maxPart   = req.partnership_count ?? 0;

      // start_date ve assigned_at'ten since hesapla
      const startDateRaw = task.start_date;
      let sinceExpr = `ta.assigned_at`; // varsayılan: atanma tarihi
      let sinceParams = [guildId, taskId]; // ek parametre gerekirse buraya
      if (startDateRaw) {
        const sp = startDateRaw.split('.');
        if (sp.length === 3 && sp.every(p => /^\d+$/.test(p.trim()))) {
          const iso = `${sp[2].trim()}-${sp[1].trim().padStart(2,'0')}-${sp[0].trim().padStart(2,'0')}`;
          sinceParams = [guildId, taskId, iso];
          sinceExpr = `GREATEST(ta.assigned_at, $3::timestamptz)`;
        }
      }

      const cfg = await (async () => {
        const { getScoreConfig } = require('../../utils/activityTracker');
        return getScoreConfig(guildId);
      })();

      // Tek SQL — tüm kullanıcıların ilerleme verisi
      const { rows } = await pool.query(`
        SELECT
          ta.user_id, ta.username, ta.status, ta.assigned_at,
          COALESCE((
            SELECT SUM(vl.active_seconds)
            FROM voice_logs vl
            WHERE vl.guild_id = $1 AND vl.user_id = ta.user_id
              AND vl.joined_at >= ${sinceExpr}
          ), 0) AS voice_seconds,
          COALESCE((
            SELECT SUM(ml.score)
            FROM message_logs ml
            WHERE ml.guild_id = $1 AND ml.user_id = ta.user_id
              AND ml.created_at >= ${sinceExpr}
          ), 0) AS msg_score,
          COALESCE((
            SELECT COUNT(*)
            FROM partnership_logs pl
            WHERE pl.guild_id = $1 AND pl.user_id = ta.user_id
              AND pl.created_at >= ${sinceExpr}
          ), 0) AS partnership_count
        FROM task_assignments ta
        WHERE ta.task_id = $2
      `, sinceParams);

      if (!rows.length) return interaction.editReply({ content: '📭 Bu göreve henüz kimse atanmamış.' });

      const STATUS_EMOJI = { bekliyor: '⏳', onay_bekleniyor: '🕐', tamamlandı: '✅', iptal: '❌' };

      const entries = rows.map(a => {
        if (a.status === 'tamamlandı') {
          return { score: Infinity, line: `✅ **${a.username}** — Tamamlandı` };
        }
        if (!hasReq) {
          return { score: 0, line: `${STATUS_EMOJI[a.status] ?? '⏳'} **${a.username}**` };
        }

        const progParts = [];
        let pct = 0;

        if (req.voice_minutes) {
          const done = Math.round((Number(a.voice_seconds) / 60) * cfg.voice_per_min * 100) / 100;
          const target = req.voice_minutes;
          const p = Math.min(100, Math.round((done / target) * 100));
          pct = Math.max(pct, p);
          progParts.push(`🎙️ ${done}/${target} **(${p}%)**`);
        }
        if (req.messages) {
          const done = Math.round(Number(a.msg_score) * 100) / 100;
          const target = req.messages;
          const p = Math.min(100, Math.round((done / target) * 100));
          pct = Math.max(pct, p);
          progParts.push(`💬 ${done}/${target} **(${p}%)**`);
        }
        if (req.partnership_count) {
          const done = parseInt(a.partnership_count);
          const target = req.partnership_count;
          const p = Math.min(100, Math.round((done / target) * 100));
          pct = Math.max(pct, p);
          progParts.push(`🤝 ${done}/${target} **(${p}%)**`);
        }

        const emoji = pct >= 100 ? '✅' : (STATUS_EMOJI[a.status] ?? '⏳');
        return {
          score: pct,
          line: `${emoji} **${a.username}** — ${progParts.join(' · ')}`,
        };
      });

      // Sırala: tamamlananlar önce, sonra yüzde azalan
      entries.sort((a, b) => b.score - a.score);

      const medals = ['🥇', '🥈', '🥉'];
      const lines  = entries.map((e, i) => {
        const rank = e.score === Infinity ? (medals[i] ?? `\`${String(i+1).padStart(2,'0')}.\``) : `\`${String(i+1).padStart(2,'0')}.\``;
        return `${rank} ${e.line}`;
      });

      const completed = rows.filter(a => a.status === 'tamamlandı').length;
      const total     = rows.length;
      const reqLabel  = hasReq ? formatRequirements(req) : '*Gereksinim yok*';

      const chunkSize = 25;
      const embeds = [];
      for (let i = 0; i < lines.length; i += chunkSize) {
        embeds.push(
          new EmbedBuilder()
            .setTitle(i === 0 ? `📊 #${taskId} — ${task.title}` : `📊 #${taskId} — Devam`)
            .setColor(0x9966ff)
            .setDescription(lines.slice(i, i + chunkSize).join('\n'))
            .setFooter({ text: `✅ ${completed}/${total} tamamlandı • Hedef: ${reqLabel}` })
        );
      }

      return interaction.editReply({ embeds: embeds.slice(0, 10) });
    }

    // ── delete ────────────────────────────────────────────────
    if (sub === 'delete') {
      const taskId = interaction.options.getInteger('id');

      const { rows: taskRows } = await pool.query(
        `SELECT id, title, status FROM tasks WHERE id = $1 AND guild_id = $2`,
        [taskId, guildId]
      );
      if (!taskRows.length) return interaction.reply({ content: `❌ #${taskId} ID'li görev bulunamadı.`, flags: MessageFlags.Ephemeral });

      const task = taskRows[0];
      if (task.status === 'iptal') return interaction.reply({ content: `❌ Bu görev zaten iptal edilmiş.`, flags: MessageFlags.Ephemeral });

      const { rows: assignRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM task_assignments WHERE task_id = $1 AND status NOT IN ('tamamlandı')`,
        [taskId]
      );
      const activeCount = parseInt(assignRows[0]?.cnt ?? 0);

      const confirmEmbed = new EmbedBuilder()
        .setColor(0xff4444)
        .setTitle('⚠️ Görevi Silmek İstediğine Emin misin?')
        .addFields(
          { name: '📌 Görev', value: `#${taskId} — ${task.title}`, inline: true },
          { name: '👥 Aktif Atama', value: `${activeCount} kişi`, inline: true },
        )
        .setDescription('Bu işlem geri alınamaz. Görev iptal edilecek ve tüm aktif atamalar kaldırılacak.');

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`task_delete_confirm_${taskId}`)
          .setLabel('Evet, Sil')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`task_delete_cancel_${taskId}`)
          .setLabel('İptal')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Secondary),
      );

      return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], flags: MessageFlags.Ephemeral });
    }
  },
};

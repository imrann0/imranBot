const {
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, RoleSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { checkPermission } = require('../utils/commandPermissions');
const { isStaff } = require('../utils/staffRoles');
const {
  getConfig, createTask, assignUsersToTask, getTask, updateTask,
  getAssignment, updateAssignment, getTaskProgress,
  buildTaskEmbed, buildTaskButtons, checkRequirements,
  createTaskNote, parseRequirements, formatRequirements,
  saveTemplate, getTemplates, getTemplate, deleteTemplate,
  checkCategoryCap, checkXpLimit, getCategories,
  sendTaskLog,
} = require('../utils/taskManager');
const { addTaskPoints, addMandatoryTaskPoints } = require('../utils/activityTracker');
const { calcTaskXP, checkPromotion, completeMandatoryFromTask } = require('../utils/roleSystem');
const { pool } = require('../utils/database');

const PRIORITY_CONFIG  = { yüksek: { emoji: '🔴', color: 0xff4444 }, orta: { emoji: '🟡', color: 0xffcc00 }, düşük: { emoji: '🟢', color: 0x44cc88 } };
const PRIORITY_POINTS  = { yüksek: 50, orta: 25, düşük: 10 };
const RECURRENCE_LABELS = { gunluk: '📅 Günlük', haftalik: '📅 Haftalık', aylik: '📅 Aylık' };

// Süper kullanıcılar: .env BOT_SUPER_USERS (veya eski adı BOT_ALLOWED_USERS) — her zaman erişimli
const SUPER_USERS = (process.env.BOT_SUPER_USERS ?? process.env.BOT_ALLOWED_USERS ?? '')
  .split(',').map(id => id.trim()).filter(Boolean);

// userId → { type, priority, points, roles, recurrence, _ts }
const taskDrafts = new Map();
// userId → { title, description, requirements, dueDate, type, priority, points, roles, members, recurrence, _ts }
const pendingTasks = new Map();

// TTL temizleme: 30 dakika boyunca güncellenmemiş taslakları temizle (bellek sızıntısı önleme)
const DRAFT_TTL = 30 * 60 * 1000; // 30 dakika
setInterval(() => {
  const now = Date.now();
  for (const [uid, draft] of taskDrafts.entries()) {
    if (!draft._ts || now - draft._ts > DRAFT_TTL) taskDrafts.delete(uid);
  }
  for (const [uid, pending] of pendingTasks.entries()) {
    if (!pending._ts || now - pending._ts > DRAFT_TTL) pendingTasks.delete(uid);
  }
}, 5 * 60 * 1000).unref(); // unref: process'in kapanmasını engellemez

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {

    // ── Herkese açık interaction'lar (izin kontrolü yapılmaz) ──
    const PUBLIC_BUTTON_IDS  = ['itiraf_open'];
    const PUBLIC_MODAL_IDS   = ['itiraf_modal'];

    const isPublicButton = interaction.isButton() && PUBLIC_BUTTON_IDS.includes(interaction.customId);
    const isPublicModal  = interaction.isModalSubmit() && PUBLIC_MODAL_IDS.includes(interaction.customId);

    // ── Kullanıcı izin kontrolü ──────────────────────────────
    if (interaction.guild && !isPublicButton && !isPublicModal) {
      const userId      = interaction.user.id;
      const isSuperUser = SUPER_USERS.includes(userId);
      const isOwner     = interaction.guild.ownerId === userId;
      const isStaffMember = (!isSuperUser && !isOwner && interaction.member)
        ? await isStaff(interaction.member).catch(() => false)
        : false;

      if (!isSuperUser && !isOwner && !isStaffMember) {
        const msg = { content: '❌ Bu botu kullanma iznin yok.', flags: MessageFlags.Ephemeral };
        if (interaction.isRepliable()) await interaction.reply(msg).catch(() => {});
        return;
      }
    }

    // ── Autocomplete ─────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        await command.autocomplete(interaction).catch(e => console.error('[Autocomplete]', e.message));
      }
      return;
    }

    // ── Slash Komutlar ───────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) return;

      // ── İzin kontrolü ────────────────────────────────────────
      const allowed = await checkPermission(interaction).catch(() => false);
      if (!allowed) {
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xff4444)
            .setTitle('🔒 Yetersiz Yetki')
            .setDescription('Bu komutu kullanma yetkin yok.\nBir yöneticiden izin talep edebilirsin.')
            .setFooter({ text: `/${interaction.commandName}` })],
          flags: MessageFlags.Ephemeral,
        });
      }
      // ─────────────────────────────────────────────────────────

      try {
        await command.execute(interaction);
      } catch (err) {
        console.error(err);
        const msg = { content: 'Bir hata oluştu!', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
        else await interaction.reply(msg);
      }
      return;
    }

    // ── Butonlar ─────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId } = interaction;

      // ── İtiraf paneli butonu → modal aç ──────────────────────
      if (customId === 'itiraf_open') {
        // Sistem aktif mi?
        const activeRes = await pool.query(
          `SELECT value FROM guild_config WHERE guild_id = $1 AND key = 'itiraf_active'`,
          [interaction.guild.id]
        );
        if (activeRes.rows[0]?.value !== '1') {
          return interaction.reply({
            content: '🔒 İtiraf sistemi şu an kapalı.',
            flags: MessageFlags.Ephemeral,
          });
        }

        // 3 saatlik cooldown — DB'den son itiraf zamanını kontrol et
        const COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 saat
        const lastRes = await pool.query(`
          SELECT created_at FROM confessions
          WHERE guild_id = $1 AND user_id = $2
          ORDER BY created_at DESC LIMIT 1
        `, [interaction.guild.id, interaction.user.id]);

        if (lastRes.rows.length) {
          const lastAt   = new Date(lastRes.rows[0].created_at).getTime();
          const remaining = COOLDOWN_MS - (Date.now() - lastAt);
          if (remaining > 0) {
            const availableAt = Math.floor((Date.now() + remaining) / 1000);
            return interaction.reply({
              content: `⏳ Tekrar itiraf göndermek için <t:${availableAt}:R> beklemelisin.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        const modal = new ModalBuilder()
          .setCustomId('itiraf_modal')
          .setTitle('💌 Anonim İtiraf')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('itiraf_content')
                .setLabel('İtirafın')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Buraya yaz... Kimse senin kim olduğunu görmeyecek.')
                .setRequired(true)
                .setMinLength(5)
                .setMaxLength(1000)
            )
          );
        return interaction.showModal(modal);
      }

      // ADIM 1 — Panel butonu
      if (customId === 'task_create') {
        // Bug fix: getCategories çağrısı kaldırıldı — buildStepOneComponents kategori almıyor
        const draft = { type: 'ses', priority: 'orta', points: 25, roles: [], recurrence: null, isMandatory: true, category: null, xpLimit: null, isPrivate: false, _ts: Date.now() };
        taskDrafts.set(interaction.user.id, draft);
        return interaction.reply({
          content: '**Görev tipini, önceliğini ve rolleri seç.**',
          ...buildStepOneComponents(draft),
          flags: MessageFlags.Ephemeral,
        });
      }

      // ADIM 1 — Şablondan yükle
      if (customId === 'task_load_templates') {
        const templates = await getTemplates(interaction.guild.id);
        if (!templates.length) {
          return interaction.reply({ content: '❌ Kayıtlı şablon yok.', flags: MessageFlags.Ephemeral });
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId('task_template_pick')
          .setPlaceholder('Şablon seç…')
          .addOptions(templates.slice(0, 25).map(t => ({
            label: t.name,
            value: String(t.id),
            description: `${t.type} · ${t.priority} · ${t.points}p`,
            emoji: '📁',
          })));
        const backBtn = new ButtonBuilder().setCustomId('task_template_back').setLabel('← Geri').setStyle(ButtonStyle.Secondary);
        return interaction.update({
          content: '📁 Yüklenecek şablonu seç:',
          components: [
            new ActionRowBuilder().addComponents(select),
            new ActionRowBuilder().addComponents(backBtn),
          ],
        });
      }


      // ADIM 1 — Şablon seçiminden geri dön
      if (customId === 'task_template_back') {
        const draft = taskDrafts.get(interaction.user.id) ?? { type: 'ses', priority: 'orta', points: 25, roles: [], recurrence: null, isMandatory: true, category: null, xpLimit: null, isPrivate: false };
        draft._ts = Date.now();
        taskDrafts.set(interaction.user.id, draft);
        return interaction.update({ content: '**Görev tipini, önceliğini ve rolleri seç.**', ...buildStepOneComponents(draft) });
      }

      // ADIM 1 → 1.5 (kategori & zorunlu seçimi)
      if (customId === 'task_open_modal') {
        const draft = taskDrafts.get(interaction.user.id) ?? { type: 'ses', priority: 'orta', points: 25, roles: [], recurrence: null, isMandatory: false, category: null, xpLimit: null, isPrivate: false };
        draft._ts = Date.now();
        taskDrafts.set(interaction.user.id, draft);
        const categories = await getCategories(interaction.guild.id);
        return interaction.update(buildStepTwoComponents(draft, categories));
      }

      // ADIM 1.5 → Geri
      if (customId === 'task_step2_back') {
        const draft = taskDrafts.get(interaction.user.id) ?? { type: 'ses', priority: 'orta', points: 25, roles: [], recurrence: null, isMandatory: false, category: null, xpLimit: null, isPrivate: false };
        draft._ts = Date.now();
        taskDrafts.set(interaction.user.id, draft);
        return interaction.update({ content: '**Görev tipini, önceliğini ve rolleri seç.**', ...buildStepOneComponents(draft) });
      }

      // ADIM 1.5 → Modal aç
      if (customId === 'task_step2_confirm') {
        const draft = taskDrafts.get(interaction.user.id) ?? { type: 'ses', priority: 'orta', points: 25, roles: [], recurrence: null, isMandatory: false, category: null, xpLimit: null, isPrivate: false };
        draft._ts = Date.now();
        taskDrafts.set(interaction.user.id, draft);
        return interaction.showModal(buildModal(draft.type));
      }

      // ── Önizleme butonları ────────────────────────────────
      if (customId === 'task_preview_confirm') {
        return publishPendingTask(interaction);
      }

      if (customId === 'task_preview_cancel') {
        pendingTasks.delete(interaction.user.id);
        taskDrafts.delete(interaction.user.id);
        return interaction.update({ content: '❌ Görev oluşturma iptal edildi.', embeds: [], components: [] });
      }

      if (customId === 'task_preview_recurrence') {
        const select = new StringSelectMenuBuilder()
          .setCustomId('task_recurrence_select')
          .setPlaceholder('Tekrarlama sıklığı seç…')
          .addOptions([
            { label: 'Tekrarlama Yok', value: 'yok', emoji: '❌' },
            { label: 'Günlük', value: 'gunluk', emoji: '📅' },
            { label: 'Haftalık', value: 'haftalik', emoji: '📅' },
            { label: 'Aylık', value: 'aylik', emoji: '📅' },
          ]);
        const backBtn = new ButtonBuilder().setCustomId('task_recurrence_back').setLabel('← Geri').setStyle(ButtonStyle.Secondary);
        return interaction.update({
          content: '🔁 Tekrarlama sıklığını seç:',
          components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(backBtn)],
        });
      }

      if (customId === 'task_recurrence_back') {
        const pending = pendingTasks.get(interaction.user.id);
        if (!pending) return interaction.update({ content: '❌ Oturum sona erdi.', components: [] });
        return interaction.update(buildPreviewMessage(pending));
      }

      if (customId === 'task_preview_save_template') {
        const modal = new ModalBuilder()
          .setCustomId('task_template_name_modal')
          .setTitle('📁 Şablon Olarak Kaydet')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('template_name').setLabel('Şablon Adı')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)
            )
          );
        return interaction.showModal(modal);
      }

      // ── Not Ekle ──────────────────────────────────────────
      // ── Görev düzenleme butonları ─────────────────────────────
      if (customId.startsWith('task_edit_text_')) {
        const taskId = parseInt(customId.replace('task_edit_text_', ''));
        const task = await getTask(interaction.guild.id, taskId);
        return interaction.showModal(new ModalBuilder()
          .setCustomId(`task_edit_text_modal_${taskId}`)
          .setTitle(`📝 Başlık / Açıklama`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_title').setLabel('Başlık')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(task?.title ?? '')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_description').setLabel('Açıklama (isteğe bağlı)')
                .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400).setValue(task?.description ?? '')
            ),
          ));
      }

      if (customId.startsWith('task_edit_dates_')) {
        const taskId = parseInt(customId.replace('task_edit_dates_', ''));
        const task = await getTask(interaction.guild.id, taskId);
        return interaction.showModal(new ModalBuilder()
          .setCustomId(`task_edit_dates_modal_${taskId}`)
          .setTitle(`📅 Tarihler`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_start').setLabel('Başlangıç Tarihi GG.AA.YYYY (boş = kaldır)')
                .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setValue(task?.start_date ?? '').setPlaceholder('05.06.2026')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_due').setLabel('Bitiş Tarihi GG.AA.YYYY (boş = kaldır)')
                .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setValue(task?.due_date ?? '').setPlaceholder('12.06.2026')
            ),
          ));
      }

      if (customId.startsWith('task_edit_req_')) {
        const taskId = parseInt(customId.replace('task_edit_req_', ''));
        const task = await getTask(interaction.guild.id, taskId);
        const reqObj = task?.requirements ?? {};
        const reqParts = [];
        if (reqObj.voice_minutes)     reqParts.push(`ses:${reqObj.voice_minutes}`);
        if (reqObj.messages)          reqParts.push(`mesaj:${reqObj.messages}`);
        if (reqObj.partnership_count) reqParts.push(`partnerlik:${reqObj.partnership_count}`);
        return interaction.showModal(new ModalBuilder()
          .setCustomId(`task_edit_req_modal_${taskId}`)
          .setTitle(`🎯 Gereksinimler`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_req').setLabel('Gereksinimler (ses:X, mesaj:X, partnerlik:X)')
                .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)
                .setValue(reqParts.join(', ')).setPlaceholder('ses:30, mesaj:50, partnerlik:5')
            ),
          ));
      }

      if (customId.startsWith('task_edit_priority_')) {
        const taskId = parseInt(customId.replace('task_edit_priority_', ''));
        return interaction.reply({
          content: '⚡ Yeni önceliği seç:',
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`task_edit_priority_select_${taskId}`)
              .setPlaceholder('Öncelik seç')
              .addOptions(
                { label: '🔴 Yüksek', value: 'yüksek' },
                { label: '🟡 Orta',   value: 'orta'   },
                { label: '🟢 Düşük',  value: 'düşük'  },
              )
          )],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (customId.startsWith('task_edit_points_')) {
        const taskId = parseInt(customId.replace('task_edit_points_', ''));
        const task = await getTask(interaction.guild.id, taskId);
        return interaction.showModal(new ModalBuilder()
          .setCustomId(`task_edit_points_modal_${taskId}`)
          .setTitle(`💰 Ödül Puanı`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_points').setLabel('Puan (5–500)')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(String(task?.points ?? 25))
            ),
          ));
      }

      if (customId.startsWith('task_edit_roles_')) {
        const taskId = parseInt(customId.replace('task_edit_roles_', ''));
        return interaction.reply({
          content: '🎭 Yeni rolleri seç (seçim yapınca kaydedilir):',
          components: [new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId(`task_edit_roles_select_${taskId}`)
              .setPlaceholder('Roller seç')
              .setMinValues(0).setMaxValues(10)
          )],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (customId.startsWith('task_edit_other_')) {
        const taskId = parseInt(customId.replace('task_edit_other_', ''));
        const task = await getTask(interaction.guild.id, taskId);
        return interaction.showModal(new ModalBuilder()
          .setCustomId(`task_edit_other_modal_${taskId}`)
          .setTitle(`⚙️ Diğer Ayarlar`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_mandatory').setLabel('Zorunlu mu? (evet / hayır)')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(task?.is_mandatory ? 'evet' : 'hayır')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_private').setLabel('Gizli mi? (evet / hayır)')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(task?.is_private ? 'evet' : 'hayır')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_xplimit').setLabel('XP Limiti (boş = sınırsız)')
                .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5).setValue(String(task?.xp_limit ?? ''))
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('edit_category').setLabel('Kategori (boş = kategorisiz)')
                .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50).setValue(task?.category ?? '')
            ),
          ));
      }

      if (customId.startsWith('task_note_')) {
        const taskId = parseInt(customId.replace('task_note_', ''));
        if (isNaN(taskId)) return interaction.reply({ content: '❌ Geçersiz görev ID.', flags: MessageFlags.Ephemeral });
        const task = await getTask(interaction.guild.id, taskId);
        if (!task) return interaction.reply({ content: '❌ Görev bulunamadı.', flags: MessageFlags.Ephemeral });

        const modal = new ModalBuilder()
          .setCustomId(`task_note_modal_${taskId}`)
          .setTitle(`📝 Görev #${taskId} Not Ekle`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('note_content').setLabel('Not')
                .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
            )
          );
        return interaction.showModal(modal);
      }

      // ── Şablon sil ────────────────────────────────────────
      // ── Görev silme onayı ────────────────────────────────────
      if (customId.startsWith('task_delete_confirm_') || customId.startsWith('task_delete_cancel_')) {
        const isConfirm = customId.startsWith('task_delete_confirm_');
        const taskId = parseInt(customId.replace(isConfirm ? 'task_delete_confirm_' : 'task_delete_cancel_', ''));
        if (isNaN(taskId)) return interaction.update({ content: '❌ Geçersiz görev ID.', embeds: [], components: [] });

        if (!isConfirm) {
          return interaction.update({ content: '❌ Silme işlemi iptal edildi.', embeds: [], components: [] });
        }

        const guildId = interaction.guild.id;
        const { rows: taskRows } = await pool.query(
          `SELECT id, title, status FROM tasks WHERE id = $1 AND guild_id = $2`,
          [taskId, guildId]
        );
        if (!taskRows.length) return interaction.update({ content: `❌ #${taskId} ID'li görev bulunamadı.`, embeds: [], components: [] });

        const task = taskRows[0];
        if (task.status === 'iptal') return interaction.update({ content: `❌ Bu görev zaten iptal edilmiş.`, embeds: [], components: [] });

        const { rowCount: assignCount } = await pool.query(
          `DELETE FROM task_assignments WHERE task_id = $1 AND status NOT IN ('tamamlandı')`,
          [taskId]
        );

        await pool.query(
          `UPDATE tasks SET status = 'iptal', updated_at = NOW() WHERE id = $1 AND guild_id = $2`,
          [taskId, guildId]
        );

        // Kanal embed'ini de güncelle
        await refreshTaskEmbed(interaction.client, guildId, taskId).catch(() => {});

        return interaction.update({
          content: `🗑️ **#${taskId} — ${task.title}** görevi silindi.\n📤 ${assignCount} aktif atama kaldırıldı.`,
          embeds: [], components: [],
        });
      }

      if (customId.startsWith('task_template_delete_')) {
        const tplId = parseInt(customId.replace('task_template_delete_', ''));
        if (isNaN(tplId)) return interaction.reply({ content: '❌ Geçersiz şablon ID.', flags: MessageFlags.Ephemeral });
        await deleteTemplate(interaction.guild.id, tplId);
        return interaction.reply({ content: `🗑️ Şablon #${tplId} silindi.`, flags: MessageFlags.Ephemeral });
      }

      // ── Terfi talebi ─────────────────────────────────────
      if (customId.startsWith('task_promo_request_')) {
        const m = customId.match(/^task_promo_request_(\d+)_(\d+)$/);
        if (!m) return interaction.reply({ content: '❌ Geçersiz talep ID.', flags: MessageFlags.Ephemeral });
        const [, roleId, userId] = m;
        const guildId = interaction.guild.id;

        // Sadece kendi butonu
        if (interaction.user.id !== userId) {
          return interaction.reply({ content: '❌ Bu buton sana ait değil.', flags: MessageFlags.Ephemeral });
        }

        const { getCfg } = require('../utils/roleSystem');
        const logChannelId = await getCfg(guildId, 'rs_log_channel');
        if (!logChannelId) {
          return interaction.reply({ content: '❌ Log kanalı ayarlanmamış. Yetkiline söyle.', flags: MessageFlags.Ephemeral });
        }
        const logChannel = interaction.client.channels.cache.get(logChannelId);
        if (!logChannel) {
          return interaction.reply({ content: '❌ Log kanalı bulunamadı.', flags: MessageFlags.Ephemeral });
        }

        // DB'ye kaydet
        const reqInsert = await pool.query(`
          INSERT INTO promotion_requests (guild_id, user_id, username, target_role_id)
          VALUES ($1, $2, $3, $4) RETURNING id
        `, [guildId, userId, interaction.user.username, roleId]);
        const reqId = reqInsert.rows[0].id;

        const promoEmbed = new EmbedBuilder()
          .setColor(0x44cc88)
          .setTitle('🎉 Terfi Talebi')
          .addFields(
            { name: '👤 Kullanıcı',   value: `<@${userId}>`,   inline: true },
            { name: '🎭 Hedef Rol',   value: `<@&${roleId}>`,  inline: true },
            { name: '📅 Tarih',       value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
          )
          .setDescription('Terfi şartlarını karşıladı. Manuel olarak rolü ver ve ardından onayla.')
          .setFooter({ text: `Talep #${reqId}` })
          .setTimestamp();

        const promoButtons = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`promo_approve_${reqId}_${userId}_${roleId}`)
            .setLabel('✅ Onayla')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`promo_reject_${reqId}_${userId}`)
            .setLabel('❌ Reddet')
            .setStyle(ButtonStyle.Danger),
        );

        await logChannel.send({ embeds: [promoEmbed], components: [promoButtons] });

        return interaction.update({
          content: '✅ Terfi talebin iletildi! Yetkilin inceleyecek.',
          components: [],
        });
      }

      // ── Terfi onayla ─────────────────────────────────────
      if (customId.startsWith('promo_approve_')) {
        const m = customId.match(/^promo_approve_(\d+)_(\d+)_(\d+)$/);
        if (!m) return interaction.reply({ content: '❌ Geçersiz terfi ID.', flags: MessageFlags.Ephemeral });
        const [, reqId, tUserId, tRoleId] = m;
        const guildId = interaction.guild.id;

        await pool.query(`
          UPDATE promotion_requests SET status = 'onaylandi', resolved_at = NOW(), resolved_by = $2
          WHERE id = $1
        `, [reqId, interaction.user.id]);

        const doneEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(0x44cc88)
          .setTitle('✅ Terfi Onaylandı')
          .setFooter({ text: `Talep #${reqId} • Onaylayan: ${interaction.user.username}` });

        await interaction.update({ embeds: [doneEmbed], components: [] });

        // Kullanıcıya log kanalında bildirim
        await interaction.followUp({
          content: `🎉 <@${tUserId}> terfin onaylandı! → <@&${tRoleId}>`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});

        return;
      }

      // ── Terfi reddet ──────────────────────────────────────
      if (customId.startsWith('promo_reject_')) {
        const m = customId.match(/^promo_reject_(\d+)_(\d+)$/);
        if (!m) return interaction.reply({ content: '❌ Geçersiz terfi ID.', flags: MessageFlags.Ephemeral });
        const [, reqId, tUserId] = m;

        await pool.query(`
          UPDATE promotion_requests SET status = 'reddedildi', resolved_at = NOW(), resolved_by = $2
          WHERE id = $1
        `, [reqId, interaction.user.id]);

        const rejEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(0xff4444)
          .setTitle('❌ Terfi Reddedildi')
          .setFooter({ text: `Talep #${reqId} • Reddeden: ${interaction.user.username}` });

        await interaction.update({ embeds: [rejEmbed], components: [] });

        // Kullanıcıya log kanalında bildirim
        await interaction.followUp({
          content: `❌ <@${tUserId}> terfi talebin reddedildi.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});

        return;
      }

      // ── İsteğe bağlı görev üstlenme ──────────────────────
      if (customId.startsWith('task_claim_')) {
        const taskId  = parseInt(customId.replace('task_claim_', ''));
        if (isNaN(taskId)) return interaction.reply({ content: '❌ Geçersiz görev ID.', flags: MessageFlags.Ephemeral });
        const guildId = interaction.guild.id;
        const task    = await getTask(guildId, taskId);

        if (!task) return interaction.reply({ content: '❌ Görev bulunamadı.', flags: MessageFlags.Ephemeral });
        if (task.status === 'iptal' || task.status === 'tamamlandı') {
          return interaction.reply({ content: '❌ Bu görev artık aktif değil.', flags: MessageFlags.Ephemeral });
        }

        // Rol kontrolü — sadece atanan rollere sahip olanlar üstlenebilir
        const assignedRoles = task.assigned_role_ids ?? [];
        if (assignedRoles.length > 0) {
          const member  = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const roleIds = new Set(assignedRoles.map(r => r.id));
          if (!member?.roles.cache.some(r => roleIds.has(r.id))) {
            return interaction.reply({ content: '❌ Bu görevi üstlenmek için gerekli role sahip değilsin.', flags: MessageFlags.Ephemeral });
          }
        }

        // Tamamlama limiti kontrolü — bu görev serisini daha fazla tamamlayabilir mi?
        const xpCheck = await checkXpLimit(task, interaction.user.id).catch(() => ({ limited: false, count: 0, limit: null }));
        if (xpCheck.limited) {
          return interaction.reply({
            content: `❌ Bu görev serisini maksimum ${xpCheck.limit} kez tamamladın. Artık katılamazsın.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        // Kategori kap kontrolü — bu kategoriden yeterince tamamladı mı?
        if (task.category) {
          const capResult = await checkCategoryCap(guildId, interaction.user.id, task.category).catch(() => ({ capped: false }));
          if (capResult.capped) {
            return interaction.reply({
              content: `❌ **${task.category}** kategorisindeki tamamlama limitine ulaştın (${capResult.total}/${capResult.totalCap}). Bu kategoriden yeni görev üstlenemezsin.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        // Mevcut atama kontrolü
        const existing = await getAssignment(taskId, interaction.user.id);
        if (existing) {
          if (existing.status === 'bekliyor' || existing.status === 'devam') {
            return interaction.reply({ content: '⏳ Bu görevi zaten üstlendin — tamamlamanı bekliyoruz!', flags: MessageFlags.Ephemeral });
          }
          if (existing.status === 'onay_bekleniyor') {
            return interaction.reply({ content: '🕐 Bu görevi üstlendin ve tamamlama isteğin admin onayında.', flags: MessageFlags.Ephemeral });
          }
          if (existing.status === 'tamamlandı') {
            return interaction.reply({ content: '✅ Bu görevi zaten tamamladın. Bir sonraki tekrarda tekrar katılabilirsin.', flags: MessageFlags.Ephemeral });
          }
        }

        // Atama oluştur — rowCount=0 ise çakışma var (başkası hızlandı), işlemi durdur
        const insertRes = await pool.query(`
          INSERT INTO task_assignments (task_id, user_id, username, assigned_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (task_id, user_id) DO NOTHING
          RETURNING task_id
        `, [taskId, interaction.user.id, interaction.user.username]);
        if (insertRes.rowCount === 0) {
          return interaction.reply({ content: '⏳ Bu görevi zaten üstlendin — tamamlamanı bekliyoruz!', flags: MessageFlags.Ephemeral });
        }

        // Embed'i güncelle (kişi listesi değişti)
        const updated = await getTask(guildId, taskId);
        const embed   = await buildTaskEmbed(updated);
        const buttons = buildTaskButtons(taskId, updated.status, updated);
        await interaction.update({ embeds: [embed], components: buttons ? [buttons] : [] });

        // Kalan tamamlama hakkı
        const kalan = task.xp_limit ? task.xp_limit - xpCheck.count : null;
        const limitStr = kalan !== null ? ` · ${kalan} tamamlama hakkın kaldı` : '';
        return interaction.followUp({ content: `🙋 **${task.title}** görevi üstlenildi!${limitStr}`, flags: MessageFlags.Ephemeral });
      }

      // ── Özel görev tamamlama ─────────────────────────────
      if (customId.startsWith('mytask_complete_')) {
        const taskId  = parseInt(customId.replace('mytask_complete_', ''));
        if (isNaN(taskId)) return interaction.reply({ content: '❌ Geçersiz görev ID.', flags: MessageFlags.Ephemeral });
        const guildId = interaction.guild?.id;
        if (!guildId) return interaction.reply({ content: '❌ Bu komutu sunucu içinde kullanmalısın.', flags: MessageFlags.Ephemeral });

        const task = await getTask(guildId, taskId);
        if (!task) return interaction.reply({ content: '❌ Görev bulunamadı.', flags: MessageFlags.Ephemeral });
        if (task.status === 'iptal' || task.status === 'tamamlandı') {
          return interaction.reply({ content: '❌ Bu görev artık aktif değil.', flags: MessageFlags.Ephemeral });
        }

        const assignment = await getAssignment(taskId, interaction.user.id);
        if (!assignment) return interaction.reply({ content: '❌ Bu görev sana atanmamış.', flags: MessageFlags.Ephemeral });
        if (assignment.status === 'tamamlandı') return interaction.reply({ content: '✅ Bu görevi zaten tamamladın.', flags: MessageFlags.Ephemeral });
        if (assignment.status === 'onay_bekleniyor') return interaction.reply({ content: '⏳ Tamamlama isteğin zaten admin onayında, lütfen bekle.', flags: MessageFlags.Ephemeral });

        const { met, progress } = await checkRequirements(guildId, interaction.user.id, assignment, task);
        if (!met) return interaction.reply({ content: `❌ **Gereksinimleri karşılamıyorsun:**\n${progress.join('\n')}`, flags: MessageFlags.Ephemeral });

        const uid = interaction.user.id;
        const uname = interaction.user.username;

        // Onay akışı: guild'de admin onayı zorunluysa direkt tamamlama yerine onay isteği gönder
        const requireApproval = (await getConfig(guildId, 'task_require_approval')) === 'true';
        if (requireApproval) {
          // Log kanalı yoksa kullanıcıyı kilitleme — önceden kontrol et
          const logChId = await getConfig(guildId, 'task_log_channel');
          if (!logChId) {
            return interaction.reply({ content: '❌ Admin log kanalı ayarlanmamış, onay sistemi çalışamıyor. Yöneticiye `/task setup log` ile kanalı ayarlamasını söyle.', flags: MessageFlags.Ephemeral });
          }
          const logCh = interaction.client.channels.cache.get(logChId);
          if (!logCh) {
            return interaction.reply({ content: '❌ Admin log kanalı bulunamadı, yöneticiye söyle.', flags: MessageFlags.Ephemeral });
          }
          await updateAssignment(taskId, uid, { status: 'onay_bekleniyor' });
          const prio = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.orta;
          const approvalEmbed = new EmbedBuilder()
            .setColor(0xff9900)
            .setTitle('✋ Görev Tamamlama Onayı Bekleniyor')
            .addFields(
              { name: '📌 Görev', value: `#${task.id} — ${task.title}`, inline: true },
              { name: '👤 Kullanıcı', value: `<@${uid}> (${uname})`, inline: true },
              { name: '⚡ Öncelik', value: `${prio.emoji} ${task.priority}`, inline: true },
              { name: '🏆 Ödül', value: `${task.points ?? 25} puan`, inline: true },
            )
            .setTimestamp();
          const approvalRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`task_onay_onayla_${task.id}_${uid}`).setLabel('Onayla').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`task_onay_reddet_${task.id}_${uid}`).setLabel('Reddet').setEmoji('❌').setStyle(ButtonStyle.Danger),
          );
          await logCh.send({ embeds: [approvalEmbed], components: [approvalRow] }).catch(() => {});
          return interaction.reply({ content: '⏳ Tamamlama isteğin admin onayına gönderildi.', flags: MessageFlags.Ephemeral });
        }

        let xpMsg = '';
        try {
          ({ xpMsg } = await completeTaskAssignment(guildId, interaction.guild, task, uid, uname, interaction.client));
        } catch (err) {
          console.error('[mytask_complete completeTaskAssignment]', err);
          return interaction.reply({ content: '❌ Görev tamamlanırken hata oluştu. Tekrar dene.', flags: MessageFlags.Ephemeral });
        }

        // Admin log: görev tamamlandı
        sendTaskLog(interaction.client, guildId, new EmbedBuilder()
          .setColor(0x44cc88).setTitle('✅ Görev Tamamlandı')
          .addFields(
            { name: '📌 Görev', value: `#${task.id} — ${task.title}`, inline: true },
            { name: '👤 Kullanıcı', value: `<@${uid}> (${uname})`, inline: true },
          ).setTimestamp(), uid
        ).catch(() => {});

        // Görev kanalındaki ana embed'i güncelle
        const updatedTask2 = await getTask(guildId, taskId);
        if (updatedTask2?.message_id && updatedTask2?.channel_id) {
          try {
            const taskCh2 = interaction.client.channels.cache.get(updatedTask2.channel_id);
            const taskMsg2 = await taskCh2?.messages.fetch(updatedTask2.message_id).catch(() => null);
            if (taskMsg2) {
              const updEmbed2 = await buildTaskEmbed(updatedTask2);
              const updBtns2 = buildTaskButtons(updatedTask2.id, updatedTask2.status, updatedTask2);
              await taskMsg2.edit({ content: `✅ **Bu görev tamamlandı.**`, embeds: [updEmbed2], components: updBtns2 ? [updBtns2] : [] }).catch(() => {});
            }
          } catch {}
        }

        const promoRole = await checkPromotion(guildId, interaction.guild, uid, uname).catch(() => null);
        if (promoRole) {
          const promoRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`task_promo_request_${promoRole.role_id}_${uid}`)
              .setLabel('Terfi Talep Et')
              .setEmoji('🎉')
              .setStyle(ButtonStyle.Success),
          );
          return interaction.reply({
            content: `✅ **${task.title}** tamamlandı!${xpMsg}\n\n🎉 **Terfi şartlarını karşıladın!** → <@&${promoRole.role_id}>`,
            components: [promoRow],
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: `✅ **${task.title}** tamamlandı!${xpMsg}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── Görevden vazgeçme (sadece isteğe bağlı) ──────────────
      if (customId.startsWith('mytask_vazgec_')) {
        const taskId  = parseInt(customId.replace('mytask_vazgec_', ''));
        if (isNaN(taskId)) return interaction.reply({ content: '❌ Geçersiz görev ID.', flags: MessageFlags.Ephemeral });
        const guildId = interaction.guild?.id;
        if (!guildId) return interaction.reply({ content: '❌ Bu komutu sunucu içinde kullanmalısın.', flags: MessageFlags.Ephemeral });

        const task = await getTask(guildId, taskId);
        if (!task) return interaction.reply({ content: '❌ Görev bulunamadı.', flags: MessageFlags.Ephemeral });

        // Sadece isteğe bağlı görevlerde geçerli
        if (task.is_mandatory === true) {
          return interaction.reply({ content: '❌ Zorunlu görevlerden vazgeçilemez.', flags: MessageFlags.Ephemeral });
        }

        const assignment = await getAssignment(taskId, interaction.user.id);
        if (!assignment) return interaction.reply({ content: '❌ Bu görev sana atanmamış.', flags: MessageFlags.Ephemeral });
        if (assignment.status === 'tamamlandı') {
          return interaction.reply({ content: '❌ Tamamlanmış görevden vazgeçilemez.', flags: MessageFlags.Ephemeral });
        }

        // Atamayı sil
        await pool.query(
          `DELETE FROM task_assignments WHERE task_id = $1 AND user_id = $2`,
          [taskId, interaction.user.id]
        );

        // Görev embed'ini güncelle (kişi listesi değişti)
        if (task.message_id && task.channel_id) {
          try {
            const ch = interaction.client.channels.cache.get(task.channel_id);
            const msg = await ch?.messages.fetch(task.message_id).catch(() => null);
            if (msg) {
              const updatedTask = await getTask(guildId, taskId);
              const updatedEmbed = await buildTaskEmbed(updatedTask);
              const updatedButtons = buildTaskButtons(updatedTask.id, updatedTask.status, updatedTask);
              await msg.edit({ embeds: [updatedEmbed], components: updatedButtons ? [updatedButtons] : [] }).catch(() => {});
            }
          } catch {}
        }

        // Admin log
        sendTaskLog(interaction.client, guildId, new EmbedBuilder()
          .setColor(0xff9900)
          .setTitle('🚪 Görevden Vazgeçildi')
          .addFields(
            { name: '📌 Görev', value: `#${task.id} — ${task.title}`, inline: true },
            { name: '👤 Kullanıcı', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
          ).setTimestamp()
        ).catch(() => {});

        return interaction.reply({
          content: `🚪 **${task.title}** görevinden vazgeçildi.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── Görev tamamlama / iptal ───────────────────────────
      if (customId.startsWith('task_complete_') || customId.startsWith('task_cancel_')) {
        const parts  = customId.split('_');
        const action = parts[1];
        const taskId = parseInt(parts[2]);
        if (isNaN(taskId)) return interaction.reply({ content: '❌ Geçersiz görev ID.', flags: MessageFlags.Ephemeral });
        const guildId = interaction.guild.id;
        const task   = await getTask(guildId, taskId);
        if (!task) return interaction.reply({ content: '❌ Görev bulunamadı.', flags: MessageFlags.Ephemeral });

        if (action === 'complete') {
          if (task.status === 'iptal' || task.status === 'tamamlandı') {
            return interaction.reply({ content: '❌ Bu görev artık aktif değil.', flags: MessageFlags.Ephemeral });
          }

          const assignment = await getAssignment(taskId, interaction.user.id);
          if (!assignment) return interaction.reply({ content: '❌ Bu görev sana atanmamış.', flags: MessageFlags.Ephemeral });
          if (assignment.status === 'tamamlandı') return interaction.reply({ content: '✅ Bu görevi zaten tamamladın.', flags: MessageFlags.Ephemeral });
          if (assignment.status === 'onay_bekleniyor') return interaction.reply({ content: '⏳ Tamamlama isteğin zaten admin onayında, lütfen bekle.', flags: MessageFlags.Ephemeral });

          const { met, progress } = await checkRequirements(guildId, interaction.user.id, assignment, task);
          if (!met) return interaction.reply({ content: `❌ **Gereksinimleri karşılamıyorsun:**\n${progress.join('\n')}`, flags: MessageFlags.Ephemeral });

          const uid = interaction.user.id;
          const uname = interaction.user.username;

          // Onay akışı kontrolü
          const requireApproval = (await getConfig(guildId, 'task_require_approval')) === 'true';
          if (requireApproval) {
            // Log kanalı yoksa kullanıcıyı kilitleme — önceden kontrol et
            const logChId = await getConfig(guildId, 'task_log_channel');
            if (!logChId) {
              return interaction.reply({ content: '❌ Admin log kanalı ayarlanmamış, onay sistemi çalışamıyor. Yöneticiye `/task setup log` ile kanalı ayarlamasını söyle.', flags: MessageFlags.Ephemeral });
            }
            const logCh = interaction.client.channels.cache.get(logChId);
            if (!logCh) {
              return interaction.reply({ content: '❌ Admin log kanalı bulunamadı, yöneticiye söyle.', flags: MessageFlags.Ephemeral });
            }
            await updateAssignment(taskId, uid, { status: 'onay_bekleniyor' });
            const prio = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.orta;
            const approvalEmbed = new EmbedBuilder()
              .setColor(0xff9900)
              .setTitle('✋ Görev Tamamlama Onayı Bekleniyor')
              .addFields(
                { name: '📌 Görev', value: `#${task.id} — ${task.title}`, inline: true },
                { name: '👤 Kullanıcı', value: `<@${uid}> (${uname})`, inline: true },
                { name: '⚡ Öncelik', value: `${prio.emoji} ${task.priority}`, inline: true },
                { name: '🏆 Ödül', value: `${task.points ?? 25} puan`, inline: true },
              ).setTimestamp();
            const approvalRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`task_onay_onayla_${task.id}_${uid}`).setLabel('Onayla').setEmoji('✅').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`task_onay_reddet_${task.id}_${uid}`).setLabel('Reddet').setEmoji('❌').setStyle(ButtonStyle.Danger),
            );
            await logCh.send({ embeds: [approvalEmbed], components: [approvalRow] }).catch(() => {});
            // Embed'i güncelle (onay_bekleniyor göster) — interaction'a ilk yanıt
            const updEmbed = await buildTaskEmbed(await getTask(guildId, taskId));
            const updButtons = buildTaskButtons(taskId, task.status, task);
            await interaction.update({ embeds: [updEmbed], components: updButtons ? [updButtons] : [] });
            return interaction.followUp({ content: '⏳ Tamamlama isteğin admin onayına gönderildi.', flags: MessageFlags.Ephemeral }).catch(() => {});
          }

          // Ortak XP mantığı (checkXpLimit → updateAssignment → puan ver → auto-close)
          let xpMsg = '';
          try {
            ({ xpMsg } = await completeTaskAssignment(guildId, interaction.guild, task, uid, uname, interaction.client));
          } catch (err) {
            console.error('[task_complete completeTaskAssignment]', err);
            return interaction.update({ content: '❌ Görev tamamlanırken hata oluştu. Tekrar dene.', components: [], embeds: [] });
          }

          // Admin log: görev tamamlandı
          sendTaskLog(interaction.client, guildId, new EmbedBuilder()
            .setColor(0x44cc88).setTitle('✅ Görev Tamamlandı')
            .addFields(
              { name: '📌 Görev', value: `#${task.id} — ${task.title}`, inline: true },
              { name: '👤 Kullanıcı', value: `<@${uid}> (${uname})`, inline: true },
            ).setTimestamp(), uid
          ).catch(() => {});

          // 1. Önce embed'i güncelle — interaction'a ilk yanıt bu olmalı
          const updatedTask = await getTask(guildId, taskId);
          const updatedEmbed = await buildTaskEmbed(updatedTask);
          const updatedButtons = buildTaskButtons(updatedTask.id, updatedTask.status, updatedTask);
          await interaction.update({ content: `✅ **Bu görev tamamlandı.**`, embeds: [updatedEmbed], components: updatedButtons ? [updatedButtons] : [] });

          // Görev kanalındaki ana embed'i de güncelle (task channel'dan tamamlandıysa zaten aynı mesaj; /my-tasks'tan geldiyse ayrıca güncelle)
          if (updatedTask.message_id && updatedTask.channel_id) {
            try {
              const taskCh = interaction.client.channels.cache.get(updatedTask.channel_id);
              const taskMsg = await taskCh?.messages.fetch(updatedTask.message_id).catch(() => null);
              if (taskMsg && taskMsg.id !== interaction.message?.id) {
                await taskMsg.edit({ content: `✅ **Bu görev tamamlandı.**`, embeds: [updatedEmbed], components: updatedButtons ? [updatedButtons] : [] }).catch(() => {});
              }
            } catch {}
          }

          // 2. Sonra XP / terfi bildirimi (followUp, ilk yanıt zaten gönderildi)
          const promoRole = await checkPromotion(guildId, interaction.guild, uid, uname).catch(() => null);
          if (promoRole) {
            const promoRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`task_promo_request_${promoRole.role_id}_${uid}`)
                .setLabel('Terfi Talep Et')
                .setEmoji('🎉')
                .setStyle(ButtonStyle.Success),
            );
            await interaction.followUp({
              content: `✅ Görev tamamlandı!${xpMsg}\n\n🎉 **Terfi şartlarını karşıladın!** → <@&${promoRole.role_id}>\nYetkilinden terfi talep etmek için butona bas.`,
              components: [promoRow],
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          } else if (xpMsg) {
            await interaction.followUp({
              content: `✅ Görev tamamlandı!${xpMsg}`,
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
          }
          return;

        } else if (action === 'cancel') {
          try {
            await updateTask(guildId, taskId, { status: 'iptal' });
            await pool.query(
              `DELETE FROM task_assignments WHERE task_id = $1 AND status NOT IN ('tamamlandı')`,
              [taskId]
            );
          } catch (err) {
            console.error('[task_cancel]', err);
            return interaction.reply({ content: '❌ İptal işlemi başarısız oldu, tekrar dene.', flags: MessageFlags.Ephemeral });
          }
        }

        // cancel durumu için embed güncelle
        const updated = await getTask(guildId, taskId);
        const embed   = await buildTaskEmbed(updated);
        const buttons = buildTaskButtons(updated.id, updated.status, updated);
        // Admin log: iptal
        if (action === 'cancel') {
          sendTaskLog(interaction.client, guildId, new EmbedBuilder()
            .setColor(0xff4444).setTitle('❌ Görev İptal Edildi')
            .addFields({ name: '📌 Görev', value: `#${taskId} — ${task.title}`, inline: true },
                       { name: '👤 İptal Eden', value: `<@${interaction.user.id}>`, inline: true })
            .setTimestamp()
          ).catch(() => {});
        }
        const msgContent = updated.status === 'iptal'
          ? `❌ **Bu görev iptal edildi.**`
          : updated.status === 'tamamlandı'
            ? `✅ **Bu görev tamamlandı.**`
            : null;
        return interaction.update({ content: msgContent, embeds: [embed], components: buttons ? [buttons] : [] });
      }

      // ── Görev tamamlama onayı (admin) ────────────────────────
      if (customId.startsWith('task_onay_onayla_') || customId.startsWith('task_onay_reddet_')) {
        const isApprove = customId.startsWith('task_onay_onayla_');
        const m = customId.match(/^task_onay_(?:onayla|reddet)_(\d+)_(\d+)$/);
        if (!m) return interaction.reply({ content: '❌ Geçersiz onay ID.', flags: MessageFlags.Ephemeral });
        const [, taskIdStr, targetUserId] = m;
        const onayTaskId = parseInt(taskIdStr);
        const guildId    = interaction.guild.id;
        const task       = await getTask(guildId, onayTaskId);
        if (!task) return interaction.reply({ content: '❌ Görev bulunamadı.', flags: MessageFlags.Ephemeral });

        // Atomic lock: iki admin aynı anda basarsa sadece biri ilerler (race condition koruması)
        const lockRes = await pool.query(
          `UPDATE task_assignments SET status = 'isleniyor'
           WHERE task_id = $1 AND user_id = $2 AND status = 'onay_bekleniyor'
           RETURNING *`,
          [onayTaskId, targetUserId]
        );
        if (lockRes.rowCount === 0) {
          return interaction.reply({ content: '❌ Bu onay isteği zaten işlendi.', flags: MessageFlags.Ephemeral });
        }

        if (!isApprove) {
          // Reddet → bekliyor'a döndür
          await pool.query(
            `UPDATE task_assignments SET status = 'bekliyor' WHERE task_id = $1 AND user_id = $2`,
            [onayTaskId, targetUserId]
          );
          // update() → followUp() sırası korunmalı
          try {
            await interaction.update({ components: [] });
          } catch { await interaction.reply({ content: '❌ Mesaj güncellenemedi.', flags: MessageFlags.Ephemeral }); return; }
          return interaction.followUp({ content: `❌ <@${targetUserId}> için tamamlama reddedildi.`, flags: MessageFlags.Ephemeral });
        }

        // Onayla → XP ver
        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
        const targetUsername = targetMember?.user.username ?? targetUserId;

        let xpMsg = '';
        try {
          ({ xpMsg } = await completeTaskAssignment(guildId, interaction.guild, task, targetUserId, targetUsername, interaction.client));
        } catch (err) {
          console.error('[task_onay_onayla]', err);
          return interaction.update({ content: '❌ Onaylama sırasında hata oluştu.', components: [] });
        }

        await interaction.update({ components: [] });

        // Task embed güncelle
        try {
          const updatedTask = await getTask(guildId, onayTaskId);
          const updatedEmbed = await buildTaskEmbed(updatedTask);
          const updatedButtons = buildTaskButtons(updatedTask.id, updatedTask.status, updatedTask);
          if (updatedTask.message_id && updatedTask.channel_id) {
            const ch = interaction.client.channels.cache.get(updatedTask.channel_id);
            const msg = await ch?.messages.fetch(updatedTask.message_id).catch(() => null);
            if (msg) await msg.edit({ content: `✅ **Bu görev tamamlandı.**`, embeds: [updatedEmbed], components: updatedButtons ? [updatedButtons] : [] }).catch(() => {});
          }
        } catch {}

        // Admin log
        sendTaskLog(interaction.client, guildId, new EmbedBuilder()
          .setColor(0x44cc88).setTitle('✅ Görev Onaylandı')
          .addFields(
            { name: '📌 Görev', value: `#${task.id} — ${task.title}`, inline: true },
            { name: '👤 Kullanıcı', value: `<@${targetUserId}>`, inline: true },
            { name: '✋ Onaylayan', value: `<@${interaction.user.id}>`, inline: true },
          ).setTimestamp(), targetUserId
        ).catch(() => {});

        return interaction.followUp({ content: `✅ <@${targetUserId}> için görev onaylandı.${xpMsg}`, flags: MessageFlags.Ephemeral });
      }
    }

    // ── Select Menüler ───────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      const draft = taskDrafts.get(interaction.user.id) ?? { type: 'ses', priority: 'orta', points: 25, roles: [], recurrence: null, isMandatory: true, category: null, xpLimit: null, isPrivate: false };

      if (interaction.customId === 'task_type_select')     draft.type     = interaction.values[0];
      if (interaction.customId === 'task_priority_select') draft.priority = interaction.values[0];
      if (interaction.customId === 'task_points_select')   draft.points   = parseInt(interaction.values[0]) || 25;
      if (interaction.customId === 'task_category_select')  draft.category   = interaction.values[0] === 'yok' ? null : interaction.values[0];
      if (interaction.customId === 'task_xp_limit_select')  draft.xpLimit    = interaction.values[0] === 'sinirsiz' ? null : (parseInt(interaction.values[0]) || null);
      if (interaction.customId === 'task_mandatory_select') draft.isMandatory = interaction.values[0] === 'zorunlu';
      if (interaction.customId === 'task_private_select')   draft.isPrivate   = interaction.values[0] === 'ozel';
      draft._ts = Date.now(); // TTL sıfırla
      taskDrafts.set(interaction.user.id, draft);

      if (['task_type_select', 'task_priority_select', 'task_points_select'].includes(interaction.customId)) {
        return interaction.update(buildStepOneComponents(draft));
      }

      if (['task_category_select', 'task_xp_limit_select', 'task_mandatory_select', 'task_private_select'].includes(interaction.customId)) {
        const categories = await getCategories(interaction.guild.id);
        return interaction.update(buildStepTwoComponents(draft, categories));
      }

      // Tekrarlama seçimi
      if (interaction.customId === 'task_recurrence_select') {
        const pending = pendingTasks.get(interaction.user.id);
        if (!pending) return interaction.update({ content: '❌ Oturum sona erdi.', components: [] });
        pending.recurrence = interaction.values[0] === 'yok' ? null : interaction.values[0];
        pending._ts = Date.now(); // TTL sıfırla
        pendingTasks.set(interaction.user.id, pending);
        return interaction.update(buildPreviewMessage(pending));
      }

      // Şablon seçimi
      if (interaction.customId === 'task_template_pick') {
        const tpl = await getTemplate(interaction.guild.id, parseInt(interaction.values[0]));
        if (!tpl) return interaction.update({ content: '❌ Şablon bulunamadı.', components: [] });
        // Bug fix: şablondaki isMandatory, category, xpLimit, isPrivate, recurrence alanları yükleniyor
        const draft = {
          type: tpl.type, priority: tpl.priority, points: tpl.points ?? 25,
          roles: [], recurrence: tpl.recurrence ?? null,
          isMandatory: tpl.is_mandatory ?? false,
          category: tpl.category ?? null,
          xpLimit: tpl.xp_limit ?? null,
          isPrivate: tpl.is_private ?? false,
          _templateDesc: tpl.description, _templateReq: tpl.requirements,
          _ts: Date.now(),
        };
        taskDrafts.set(interaction.user.id, draft);
        return interaction.update({ content: `✅ **${tpl.name}** şablonu yüklendi.`, ...buildStepOneComponents(draft) });
      }
    }

    if (interaction.isRoleSelectMenu() && interaction.customId === 'task_role_select') {
      const draft = taskDrafts.get(interaction.user.id) ?? { type: 'ses', priority: 'orta', points: 25, roles: [], recurrence: null, isMandatory: true, category: null, xpLimit: null, isPrivate: false };
      draft.roles = interaction.roles.map(r => ({ id: r.id, name: r.name }));
      draft._ts = Date.now(); // TTL sıfırla
      taskDrafts.set(interaction.user.id, draft);
      return interaction.update(buildStepOneComponents(draft));
    }

    // ── Select Menu (görev düzenleme) ────────────────────────
    if (interaction.isAnySelectMenu()) {
      const { customId } = interaction;

      // Öncelik seçimi
      if (customId.startsWith('task_edit_priority_select_')) {
        const taskId  = parseInt(customId.replace('task_edit_priority_select_', ''));
        const guildId = interaction.guild.id;
        const priority = interaction.values[0];
        await updateTask(guildId, taskId, { priority });
        await refreshTaskEmbed(interaction.client, guildId, taskId);
        return interaction.update({ content: `✅ Öncelik güncellendi: **${priority}**.`, components: [] });
      }

      // Rol seçimi
      if (customId.startsWith('task_edit_roles_select_')) {
        const taskId  = parseInt(customId.replace('task_edit_roles_select_', ''));
        const guildId = interaction.guild.id;
        const roles   = interaction.roles.map(r => ({ id: r.id, name: r.name }));
        await updateTask(guildId, taskId, { assigned_role_ids: JSON.stringify(roles) });
        await refreshTaskEmbed(interaction.client, guildId, taskId);
        return interaction.update({ content: `✅ Roller güncellendi.`, components: [] });
      }
    }

    // ── Modal Submit ──────────────────────────────────────────
    if (interaction.isModalSubmit()) {

      // İtiraf modalı
      if (interaction.customId === 'itiraf_modal') {
        const content = interaction.fields.getTextInputValue('itiraf_content');
        const guildId = interaction.guild.id;

        const res = await pool.query(`SELECT value FROM guild_config WHERE guild_id = $1 AND key = 'itiraf_channel'`, [guildId]);
        const channelId = res.rows[0]?.value;
        if (!channelId) {
          return interaction.reply({ content: '❌ İtiraf kanalı ayarlanmamış.', flags: MessageFlags.Ephemeral });
        }

        const ch = interaction.client.channels.cache.get(channelId);
        if (!ch) {
          return interaction.reply({ content: '❌ İtiraf kanalı bulunamadı.', flags: MessageFlags.Ephemeral });
        }

        const insertRes = await pool.query(`INSERT INTO confessions (guild_id, user_id, content) VALUES ($1, $2, $3) RETURNING id`, [guildId, interaction.user.id, content]);
        const num = insertRes.rows[0].id;

        const embed = new EmbedBuilder()
          .setColor(0xff69b4)
          .setTitle(`💌 Anonim İtiraf #${String(num).padStart(3, '0')}`)
          .setDescription(`> ${content}`)
          .setTimestamp()
          .setFooter({ text: 'Anonim · İtiraf Kutusu' });

        await ch.send({ embeds: [embed] });

        return interaction.reply({
          content: `✅ İtirafın **#${String(num).padStart(3, '0')}** numarasıyla anonim olarak gönderildi!`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // Görev oluşturma modalı → önizleme
      if (interaction.customId.startsWith('task_modal_')) {
        const draft = taskDrafts.get(interaction.user.id) ?? { type: 'ses', priority: 'orta', points: 25, roles: [], recurrence: null };
        const type  = interaction.customId.replace('task_modal_', '');

        const title       = interaction.fields.getTextInputValue('task_title');
        const description = (type !== 'karma' ? interaction.fields.getTextInputValue('task_description') : null) || draft._templateDesc || null;
        const startDate   = interaction.fields.getTextInputValue('task_start_date') || null;
        const dueDate     = interaction.fields.getTextInputValue('task_due') || null;

        let requirements = draft._templateReq ?? null;
        if (type === 'ses')        requirements = `ses:${interaction.fields.getTextInputValue('task_voice_minutes')}`;
        if (type === 'mesaj')      requirements = `mesaj:${interaction.fields.getTextInputValue('task_message_count')}`;
        if (type === 'karma')      requirements = `ses:${interaction.fields.getTextInputValue('task_voice_minutes')},mesaj:${interaction.fields.getTextInputValue('task_message_count')}`;
        if (type === 'partnerlik') {
          // Partnerlik kanalı tanımlanmış olmalı
          const pCh = await getConfig(interaction.guild.id, 'partnership_channel');
          if (!pCh) {
            return interaction.reply({
              content: '❌ Önce `/partnership setup` ile partnerlik kanalını tanımlamalısın!',
              flags: MessageFlags.Ephemeral,
            });
          }
          requirements = `partnerlik:${interaction.fields.getTextInputValue('task_partnership_count')}`;
        }

        // Üyeleri önceden topla
        let members = [];
        if (draft.roles?.length) {
          const allMembers = await interaction.guild.members.fetch();
          const roleIds = new Set(draft.roles.map(r => r.id));
          const memberMap = new Map();
          allMembers.forEach(m => { if (m.roles.cache.some(r => roleIds.has(r.id))) memberMap.set(m.id, m); });
          members = [...memberMap.values()];
        }

        const pending = { title, description, requirements, startDate, dueDate, type, members,
          priority: draft.priority ?? 'orta', points: draft.points ?? 25,
          roles: draft.roles ?? [], recurrence: draft.recurrence ?? null,
          isMandatory: draft.isMandatory ?? true, category: draft.category ?? null,
          xpLimit: draft.xpLimit ?? null, isPrivate: draft.isPrivate ?? false,
          _ts: Date.now(),
        };
        pendingTasks.set(interaction.user.id, pending);

        return interaction.reply({ ...buildPreviewMessage(pending), flags: MessageFlags.Ephemeral });
      }

      // ── Yeni edit sistem modal handler'ları ───────────────────

      // Başlık/Açıklama
      if (interaction.customId.startsWith('task_edit_text_modal_')) {
        const taskId  = parseInt(interaction.customId.replace('task_edit_text_modal_', ''));
        const guildId = interaction.guild.id;
        const title       = interaction.fields.getTextInputValue('edit_title');
        const description = interaction.fields.getTextInputValue('edit_description') || null;
        await updateTask(guildId, taskId, { title, description });
        await refreshTaskEmbed(interaction.client, guildId, taskId);
        return interaction.reply({ content: `✅ Başlık/Açıklama güncellendi.`, flags: MessageFlags.Ephemeral });
      }

      // Tarihler
      if (interaction.customId.startsWith('task_edit_dates_modal_')) {
        const taskId  = parseInt(interaction.customId.replace('task_edit_dates_modal_', ''));
        const guildId = interaction.guild.id;
        const startDate = interaction.fields.getTextInputValue('edit_start') || null;
        const dueDate   = interaction.fields.getTextInputValue('edit_due') || null;
        await updateTask(guildId, taskId, { start_date: startDate, due_date: dueDate });
        await refreshTaskEmbed(interaction.client, guildId, taskId);
        return interaction.reply({ content: `✅ Tarihler güncellendi.`, flags: MessageFlags.Ephemeral });
      }

      // Gereksinimler
      if (interaction.customId.startsWith('task_edit_req_modal_')) {
        const taskId  = parseInt(interaction.customId.replace('task_edit_req_modal_', ''));
        const guildId = interaction.guild.id;
        const reqRaw  = interaction.fields.getTextInputValue('edit_req') || '';
        const reqObj  = parseRequirements(reqRaw);
        await updateTask(guildId, taskId, { requirements: JSON.stringify(reqObj) });
        await refreshTaskEmbed(interaction.client, guildId, taskId);
        return interaction.reply({ content: `✅ Gereksinimler güncellendi.`, flags: MessageFlags.Ephemeral });
      }

      // Puan
      if (interaction.customId.startsWith('task_edit_points_modal_')) {
        const taskId  = parseInt(interaction.customId.replace('task_edit_points_modal_', ''));
        const guildId = interaction.guild.id;
        const points  = parseInt(interaction.fields.getTextInputValue('edit_points')) || 25;
        await updateTask(guildId, taskId, { points });
        await refreshTaskEmbed(interaction.client, guildId, taskId);
        return interaction.reply({ content: `✅ Puan güncellendi: **${points}p**.`, flags: MessageFlags.Ephemeral });
      }

      // Diğer (zorunlu, gizli, XP limiti, kategori)
      if (interaction.customId.startsWith('task_edit_other_modal_')) {
        const taskId     = parseInt(interaction.customId.replace('task_edit_other_modal_', ''));
        const guildId    = interaction.guild.id;
        const isMandatory = interaction.fields.getTextInputValue('edit_mandatory').toLowerCase().startsWith('e');
        const isPrivate   = interaction.fields.getTextInputValue('edit_private').toLowerCase().startsWith('e');
        const xpLimit     = parseInt(interaction.fields.getTextInputValue('edit_xplimit')) || null;
        const category    = interaction.fields.getTextInputValue('edit_category') || null;
        await updateTask(guildId, taskId, { is_mandatory: isMandatory, is_private: isPrivate, xp_limit: xpLimit, category });
        await refreshTaskEmbed(interaction.client, guildId, taskId);
        return interaction.reply({ content: `✅ Diğer ayarlar güncellendi.`, flags: MessageFlags.Ephemeral });
      }

      // Not ekleme modalı
      if (interaction.customId.startsWith('task_note_modal_')) {
        const taskId = parseInt(interaction.customId.replace('task_note_modal_', ''));
        if (isNaN(taskId)) return interaction.reply({ content: '❌ Geçersiz görev ID.', flags: MessageFlags.Ephemeral });
        const guildId = interaction.guild.id;
        const content = interaction.fields.getTextInputValue('note_content');

        await createTaskNote(taskId, interaction.user.id, interaction.user.username, content);

        const task    = await getTask(guildId, taskId);
        const embed   = await buildTaskEmbed(task);
        const buttons = buildTaskButtons(taskId, task.status, task);

        if (task.message_id && task.channel_id) {
          try {
            const ch = interaction.client.channels.cache.get(task.channel_id);
            const msg = await ch?.messages.fetch(task.message_id);
            if (msg) await msg.edit({ embeds: [embed], components: buttons ? [buttons] : [] });
          } catch {}
        }

        return interaction.reply({ content: `📝 Notun **#${taskId}** görevine eklendi.`, flags: MessageFlags.Ephemeral });
      }

      // Şablon adı modalı → şablonu kaydet, önizlemeye geri dön
      if (interaction.customId === 'task_template_name_modal') {
        const name    = interaction.fields.getTextInputValue('template_name');
        const pending = pendingTasks.get(interaction.user.id);
        if (!pending) return interaction.reply({ content: '❌ Oturum sona erdi.', flags: MessageFlags.Ephemeral });

        await saveTemplate({
          guildId: interaction.guild.id,
          name, type: pending.type, priority: pending.priority, points: pending.points,
          description: pending.description, requirements: pending.requirements,
          createdById: interaction.user.id, createdByUsername: interaction.user.username,
          // Bug fix: eksik alanlar eklendi
          isMandatory: pending.isMandatory,
          category: pending.category,
          xpLimit: pending.xpLimit,
          isPrivate: pending.isPrivate,
          recurrence: pending.recurrence,
        });

        return interaction.reply({
          content: `📁 **${name}** şablonu kaydedildi. Önizleme ekranından Tekrarlayan Yap veya Yayınla butonuna basabilirsin.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

// ── Bekleyen görevi yayınla ──────────────────────────────────
async function publishPendingTask(interaction, alreadyReplied = false) {
  try {
  const pending = pendingTasks.get(interaction.user.id);
  if (!pending) {
    const msg = { content: '❌ Oturum sona erdi, tekrar dene.', flags: MessageFlags.Ephemeral };
    return alreadyReplied ? interaction.followUp(msg) : interaction.update({ content: msg.content, embeds: [], components: [] });
  }

  const guildId = interaction.guild.id;
  const tasksChannelId = await getConfig(guildId, 'task_tasks_channel');

  // Özel görev kanala gönderilmeyeceği için kanal zorunlu değil
  if (!pending.isPrivate) {
    if (!tasksChannelId) {
      const msg = { content: '❌ `/task setup` ile görev kanalını ayarla.', flags: MessageFlags.Ephemeral };
      return alreadyReplied ? interaction.followUp(msg) : interaction.update({ content: msg.content, embeds: [], components: [] });
    }
    const tasksChannel = interaction.client.channels.cache.get(tasksChannelId);
    if (!tasksChannel) {
      const msg = { content: '❌ Görev kanalı bulunamadı.', flags: MessageFlags.Ephemeral };
      return alreadyReplied ? interaction.followUp(msg) : interaction.update({ content: msg.content, embeds: [], components: [] });
    }
  }

  const taskId = await createTask({
    guildId,
    title: pending.title, description: pending.description,
    requirements: pending.requirements, startDate: pending.startDate, dueDate: pending.dueDate,
    priority: pending.priority, points: pending.points,
    assignedRoles: pending.roles, recurrence: pending.recurrence,
    createdById: interaction.user.id, createdByUsername: interaction.user.username,
    isMandatory: pending.isMandatory ?? true,
    category: pending.category ?? null,
    xpLimit: pending.xpLimit ?? null,
    isPrivate: pending.isPrivate ?? false,
    type: pending.type ?? null,
  });

  // Özel görev → her zaman assign et (DM gönderilen kişiler tamamlayabilmeli)
  // Zorunlu veya tekrarlayan → otomatik assign
  // İsteğe bağlı + tek seferlik + herkese açık → Üstlen butonuyla kullanıcı kendisi katılır
  const shouldAutoAssign = pending.isPrivate || pending.isMandatory === true || pending.recurrence != null;
  if (shouldAutoAssign && pending.members?.length) {
    console.log(`🎯 Görev #${taskId} → ${pending.members.length} kişiye atandı`);
    await assignUsersToTask(taskId, pending.members);
  }

  if (pending.isPrivate) {
    // Özel görev: kanal üzerinden @mention ile bildir (DM yok)
    if (tasksChannelId) {
      const notifyChannel = interaction.client.channels.cache.get(tasksChannelId);
      if (notifyChannel && pending.members?.length) {
        const mentions = pending.members.map(m => `<@${m.id}>`).join(' ');
        await notifyChannel.send({
          content: `🔒 ${mentions}\nSana özel bir görev atandı. Görmek için **\`/my-tasks\`** veya **\`i?mytasks\`** kullan.`,
          allowedMentions: { users: pending.members.map(m => m.id) },
        }).catch(() => {});
      }
    }
  } else {
    const tasksChannel = interaction.client.channels.cache.get(tasksChannelId);
    // Fix: tasksChannel null ise crash önle
    if (!tasksChannel) {
      const msg = { content: '❌ Görev kanalı bulunamadı.', flags: MessageFlags.Ephemeral };
      return alreadyReplied ? interaction.followUp(msg) : interaction.update({ content: msg.content, embeds: [], components: [] });
    }
    const task    = await getTask(guildId, taskId);
    const embed   = await buildTaskEmbed(task);
    const buttons = buildTaskButtons(taskId, task.status, task);

    const isMandatory = pending.isMandatory === true;
    const isRecurring = pending.recurrence != null;
    const recLabel = { gunluk: 'Günlük', haftalik: 'Haftalık', aylik: 'Aylık' }[pending.recurrence] ?? '';
    const mentionContent = pending.roles?.length
      ? isMandatory
        ? pending.roles.map(r => `<@&${r.id}>`).join(' ')
        : isRecurring
          ? `🔁 **${recLabel} Görev** — ${pending.roles.map(r => `<@&${r.id}>`).join(', ')}`
          : `🎯 **İsteğe Bağlı Görev** — ${pending.roles.map(r => `<@&${r.id}>`).join(', ')} — katılmak için **Üstlen**'e tıklayın!`
      : null;

    const msg = await tasksChannel.send({
      content: mentionContent,
      embeds: [embed],
      components: buttons ? [buttons] : [],
      allowedMentions: { roles: (pending.roles ?? []).map(r => r.id) },
    });
    await updateTask(guildId, taskId, { message_id: msg.id, channel_id: tasksChannelId });
  }

  pendingTasks.delete(interaction.user.id);
  taskDrafts.delete(interaction.user.id);

  // Admin log: görev oluşturuldu
  sendTaskLog(interaction.client, guildId, new EmbedBuilder()
    .setColor(0x9966ff).setTitle('📌 Yeni Görev Oluşturuldu')
    .addFields(
      { name: '📌 Görev', value: `#${taskId} — ${pending.title}`, inline: true },
      { name: '✍️ Oluşturan', value: `<@${interaction.user.id}>`, inline: true },
      { name: '🔖 Tür', value: pending.isMandatory ? '⚠️ Zorunlu' : '🎯 İsteğe Bağlı', inline: true },
      { name: '🏆 Puan', value: `${pending.points ?? 25}`, inline: true },
    ).setTimestamp()
  ).catch(() => {});

  const recStr = pending.recurrence ? ` · 🔁 ${RECURRENCE_LABELS[pending.recurrence]}` : '';
  const privateStr = pending.isPrivate ? ' · 🔒 Özel (Kanal bildirimi gönderildi)' : '';
  const memberCount = pending.members?.length ?? 0;
  const successMsg = { content: `✅ Görev **#${taskId}** yayınlandı! ${memberCount ? `${memberCount} kişiye atandı.` : ''}${recStr}${privateStr}`, flags: MessageFlags.Ephemeral };

  return alreadyReplied
    ? interaction.followUp(successMsg)
    : interaction.update({ ...successMsg, embeds: [], components: [] });

  } catch (err) {
    console.error('[publishPendingTask]', err);
    const errMsg = { content: '❌ Görev oluşturulurken bir hata oluştu. Lütfen tekrar dene.', flags: MessageFlags.Ephemeral };
    if (alreadyReplied) return interaction.followUp(errMsg).catch(() => {});
    return interaction.update({ content: errMsg.content, embeds: [], components: [] }).catch(() => {});
  }
}

// ── Görev embed'ini kanalda güncelle ─────────────────────────
async function refreshTaskEmbed(client, guildId, taskId) {
  try {
    const task    = await getTask(guildId, taskId);
    if (!task?.message_id || !task?.channel_id) return;
    const ch  = client.channels.cache.get(task.channel_id);
    const msg = await ch?.messages.fetch(task.message_id).catch(() => null);
    if (!msg) return;
    const embed   = await buildTaskEmbed(task);
    const buttons = buildTaskButtons(taskId, task.status, task);
    const msgContent = task.status === 'iptal'
      ? `❌ **Bu görev iptal edildi.**`
      : task.status === 'tamamlandı'
        ? `✅ **Bu görev tamamlandı.**`
        : null;
    await msg.edit({ content: msgContent, embeds: [embed], components: buttons ? [buttons] : [] });
  } catch {}
}

// ── Görev tamamlama — ortak XP mantığı ──────────────────────
// task_complete_ ve mytask_complete_ butonlarının tekrar eden kodunu buraya topladık
async function completeTaskAssignment(guildId, guild, task, userId, username, client = null) {
  const basePoints = task.points ?? PRIORITY_POINTS[task.priority] ?? 25;

  // XP limit kontrolü updateAssignment'tan ÖNCE yapılmalı (off-by-one önleme)
  const xpLimitResult = await checkXpLimit(task, userId).catch(() => ({ limited: false, count: 0, limit: null }));

  await updateAssignment(task.id, userId, { status: 'tamamlandı', completed_at: new Date().toISOString() });

  let xpMsg = '';

  if (task.is_mandatory === true) {
    if (xpLimitResult.limited) {
      xpMsg = `\n⚠️ Zorunlu görev tamamlandı · Tamamlama limiti doldu (${xpLimitResult.count}/${xpLimitResult.limit} kez)`;
    } else {
      const { finalPoints } = await calcTaskXP(guildId, guild, userId, basePoints).catch(() => ({ finalPoints: basePoints }));
      await addMandatoryTaskPoints(guildId, userId, username, finalPoints, `Zorunlu görev #${task.id}: ${task.title}`);
      const mandResult = await completeMandatoryFromTask(guildId, userId, username).catch(() => null);
      const newStreak    = mandResult?.newStreak  ?? null;
      const streakBroken = mandResult?.streakBroken ?? false;
      const oldStreak    = mandResult?.oldStreak    ?? 0;
      const tamamSayisi = xpLimitResult.count + 1;
      const limitStr = task.xp_limit ? ` · ${tamamSayisi}/${task.xp_limit} tamamlandı` : '';
      xpMsg = `\n⚠️ Zorunlu görev · **+${finalPoints}** puan${limitStr}${newStreak > 1 ? ` · 🔥 ${newStreak} hafta streak` : ''}`;

    }
  } else {
    let capped = false;
    if (task.category) {
      const capResult = await checkCategoryCap(guildId, userId, task.category).catch(() => ({ capped: false }));
      if (capResult.capped) {
        capped = true;
        xpMsg = `\n🚫 **${task.category}** kategorisi doldu (${capResult.total}/${capResult.totalCap}) — puan kazanılmadı.`;
      }
    }
    if (!capped) {
      if (xpLimitResult.limited) {
        xpMsg = `\n⚠️ Tamamlama limiti doldu (${xpLimitResult.count}/${xpLimitResult.limit} kez) — puan kazanılmadı.`;
      } else {
        const { finalPoints, multiplier, overLimit } = await calcTaskXP(guildId, guild, userId, basePoints).catch(() => ({ finalPoints: basePoints, multiplier: 1, overLimit: false }));
        await addTaskPoints(guildId, userId, username, finalPoints, `Görev #${task.id}: ${task.title}`);
        const tamamSayisi = xpLimitResult.count + 1;
        const limitStr = task.xp_limit ? ` · ${tamamSayisi}/${task.xp_limit} tamamlandı` : '';
        xpMsg = `\n🎯 **+${finalPoints}** puan (${multiplier}x çarpan${overLimit ? ' ⚠️ Limit aşıldı (%60)' : ''})${limitStr}`;
      }
    }
  }

  // Zorunlu görevler: tüm atamalar tamamlanınca task-level'da da kapat
  if (task.is_mandatory === true) {
    const allAssignments = await getTaskProgress(task.id);
    if (allAssignments.every(a => a.status === 'tamamlandı')) {
      await updateTask(guildId, task.id, { status: 'tamamlandı' });
    }
  }

  return { xpMsg };
}

// ── Önizleme mesajı ──────────────────────────────────────────
function buildPreviewMessage(pending) {
  const prio    = PRIORITY_CONFIG[pending.priority] ?? PRIORITY_CONFIG.orta;
  const roles   = pending.roles ?? [];
  const roleStr = roles.length ? roles.map(r => `<@&${r.id}>`).join(', ') : '*Yok*';
  const req     = parseRequirements(pending.requirements);

  const embed = new EmbedBuilder()
    .setTitle(`👁️ Önizleme: ${pending.title}`)
    .setColor(prio.color)
    .addFields(
      { name: '⚡ Öncelik',        value: `${prio.emoji} ${pending.priority}`,                        inline: true },
      { name: '🏆 Ödül Puanı',    value: `${pending.points} puan`,                                   inline: true },
      { name: '📅 Başlangıç',     value: pending.startDate ?? '*Belirtilmedi*',                       inline: true },
      { name: '⏰ Bitiş',          value: pending.dueDate ?? '*Belirtilmedi*',                        inline: true },
      { name: '🔁 Tekrarlama',    value: pending.recurrence ? RECURRENCE_LABELS[pending.recurrence] : '*Yok*', inline: true },
      { name: '👥 Atanacak',      value: `${pending.members.length} kişi`,                           inline: true },
      { name: '🔖 Tür',        value: pending.isMandatory ? '⚠️ Zorunlu' : '🎯 İsteğe Bağlı',   inline: true },
      { name: '📂 Kategori',   value: pending.category ?? '*Kategorisiz*',                        inline: true },
      { name: '🔂 XP Limiti',  value: pending.xpLimit ? `${pending.xpLimit} kez` : 'Sınırsız',  inline: true },
      { name: '🎭 Roller',        value: roleStr,                                                     inline: false },
      { name: '📋 Gereksinimler', value: formatRequirements(req),                                     inline: false },
    )
    .setFooter({ text: 'Onaylamak için Yayınla butonuna bas.' });

  if (pending.description) embed.setDescription(pending.description);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('task_preview_confirm').setLabel('Yayınla').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('task_preview_recurrence').setLabel(pending.recurrence ? RECURRENCE_LABELS[pending.recurrence] : 'Tekrarlayan Yap').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('task_preview_save_template').setLabel('Şablon Kaydet').setEmoji('📁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('task_preview_cancel').setLabel('İptal').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );

  return { content: '', embeds: [embed], components: [row] };
}

// ── Adım 1 bileşenleri ───────────────────────────────────────
function buildStepOneComponents(draft) {
  const TYPE_LABELS  = { ses: '🎙️ Ses Görevi', mesaj: '💬 Mesaj Görevi', karma: '⚡ Karma Görev', partnerlik: '🤝 Partnerlik' };
  const PRIO_LABELS  = { düşük: '🟢 Düşük', orta: '🟡 Orta', yüksek: '🔴 Yüksek' };
  const POINT_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200];
  const currentPoints = draft.points ?? 25;

  const roleLabel = draft.roles?.length
    ? `Seçili: ${draft.roles.map(r => r.name).join(', ')}`
    : 'Atanacak rolleri seç (isteğe bağlı)';

  const typeRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('task_type_select')
      .setPlaceholder(TYPE_LABELS[draft.type] ?? 'Görev tipini seç')
      .addOptions([
        { label: 'Ses Görevi',   value: 'ses',    emoji: '🎙️', description: 'Belirli süre seste olunmalı',   default: draft.type === 'ses'    },
        { label: 'Mesaj Görevi', value: 'mesaj',  emoji: '💬', description: 'Belirli sayıda mesaj atılmalı', default: draft.type === 'mesaj'  },
        { label: 'Karma Görev',  value: 'karma',       emoji: '⚡', description: 'Ses + mesaj kombinasyonu',       default: draft.type === 'karma'       },
        { label: 'Partnerlik',   value: 'partnerlik',  emoji: '🤝', description: 'Partnerlik kanalında mesaj atılmalı', default: draft.type === 'partnerlik' },
      ])
  );

  const priorityRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('task_priority_select')
      .setPlaceholder(PRIO_LABELS[draft.priority] ?? 'Öncelik seç')
      .addOptions([
        { label: 'Düşük',  value: 'düşük',  emoji: '🟢', default: draft.priority === 'düşük'  },
        { label: 'Orta',   value: 'orta',   emoji: '🟡', default: draft.priority === 'orta'   },
        { label: 'Yüksek', value: 'yüksek', emoji: '🔴', default: draft.priority === 'yüksek' },
      ])
  );

  const pointsRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('task_points_select')
      .setPlaceholder(`🏆 Ödül Puanı: ${currentPoints}`)
      .addOptions(POINT_OPTIONS.map(p => ({ label: `${p} puan`, value: String(p), emoji: '🏆', default: p === currentPoints })))
  );

  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('task_role_select')
      .setPlaceholder(roleLabel.slice(0, 100)).setMinValues(0).setMaxValues(10)
  );

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('task_load_templates').setLabel('Şablondan Yükle').setEmoji('📁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('task_open_modal').setLabel('Devam Et →').setEmoji('➡️').setStyle(ButtonStyle.Primary),
  );

  return { components: [typeRow, priorityRow, pointsRow, roleRow, btnRow] };
}

// ── Adım 1.5 — Kategori, XP Limit & Zorunlu seçimi ──────────
function buildStepTwoComponents(draft, categories) {
  // Null güvenliği: isMandatory undefined/null ise zorunlu varsay
  if (draft.isMandatory == null) draft.isMandatory = true;
  const catOptions = [{ label: 'Kategorisiz', value: 'yok', emoji: '📂', default: !draft.category }];
  for (const c of categories) {
    catOptions.push({ label: c.name, value: c.name, emoji: '📌', description: `Kap: ${c.total_cap}`, default: draft.category === c.name });
  }

  const catRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('task_category_select')
      .setPlaceholder(draft.category ? `📂 ${draft.category}` : '📂 Kategori seç (isteğe bağlı)')
      .addOptions(catOptions.slice(0, 25))
  );

  const XP_LIMIT_OPTIONS = [
    { label: 'Sınırsız', value: 'sinirsiz', emoji: '♾️', description: 'Her tamamlamada XP verir' },
    { label: '1 kez',    value: '1',         emoji: '1️⃣', description: 'Sadece ilk tamamlamada XP' },
    { label: '3 kez',    value: '3',         emoji: '3️⃣', description: 'Maksimum 3 tamamlamada XP' },
    { label: '5 kez',    value: '5',         emoji: '5️⃣', description: 'Maksimum 5 tamamlamada XP' },
    { label: '10 kez',   value: '10',        emoji: '🔟', description: 'Maksimum 10 tamamlamada XP' },
  ];
  const currentLimit = draft.xpLimit ? String(draft.xpLimit) : 'sinirsiz';

  const limitRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('task_xp_limit_select')
      .setPlaceholder(draft.xpLimit ? `🔂 XP Limiti: ${draft.xpLimit} kez` : '♾️ XP Limiti: Sınırsız')
      .addOptions(XP_LIMIT_OPTIONS.map(o => ({ ...o, default: o.value === currentLimit })))
  );

  const mandatoryRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('task_mandatory_select')
      .setPlaceholder(draft.isMandatory ? '⚠️ Zorunlu' : '🎯 İsteğe Bağlı')
      .addOptions([
        { label: 'Zorunlu',        value: 'zorunlu',  emoji: '⚠️', description: 'Tüm atanan kişiler tamamlamalı',    default: draft.isMandatory === true  },
        { label: 'İsteğe Bağlı',  value: 'istege',   emoji: '🎯', description: 'Kullanıcı kendisi üstlenebilir',    default: draft.isMandatory === false },
      ])
  );

  const privateRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('task_private_select')
      .setPlaceholder(draft.isPrivate ? '🔒 Özel' : '🌍 Herkese Açık')
      .addOptions([
        { label: 'Herkese Açık', value: 'acik',  emoji: '🌍', description: 'Görev kanalında yayınlanır',         default: draft.isPrivate === false },
        { label: 'Özel',         value: 'ozel',  emoji: '🔒', description: 'Sadece atananlara DM ile gönderilir', default: draft.isPrivate === true  },
      ])
  );

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('task_step2_back').setLabel('← Geri').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('task_step2_confirm').setLabel('Devam Et →').setEmoji('➡️').setStyle(ButtonStyle.Primary),
  );

  const limitLabel = draft.xpLimit ? `${draft.xpLimit} kez` : 'Sınırsız';
  return {
    content: `**Kategori, XP limiti ve görev türünü seç.**\n🔖 **${draft.isMandatory ? '⚠️ Zorunlu' : '🎯 İsteğe Bağlı'}** · 📂 **${draft.category ?? 'Kategorisiz'}** · 🔂 **${limitLabel}** · ${draft.isPrivate ? '🔒 **Özel**' : '🌍 **Herkese Açık**'}`,
    components: [catRow, limitRow, mandatoryRow, privateRow, btnRow],
  };
}

// ── Modal oluşturucu ─────────────────────────────────────────
function buildModal(type) {
  const modal = new ModalBuilder()
    .setCustomId(`task_modal_${type}`)
    .setTitle(
      type === 'ses'        ? '🎙️ Ses Görevi'    :
      type === 'mesaj'      ? '💬 Mesaj Görevi'  :
      type === 'karma'      ? '⚡ Karma Görev'   :
      type === 'partnerlik' ? '🤝 Partnerlik'    : '📋 Manuel Görev'
    );

  // karma: 5 satır dolduğu için description yok → title + ses + mesaj + başlangıç + bitiş
  const rows = [
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('task_title').setLabel('Görev Başlığı')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
    ),
  ];

  if (type !== 'karma') {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('task_description').setLabel('Açıklama (isteğe bağlı)')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400)
    ));
  }

  if (type === 'ses' || type === 'karma') rows.push(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('task_voice_minutes').setLabel('Gerekli Ses Süresi (dakika)')
      .setStyle(TextInputStyle.Short).setPlaceholder('60').setRequired(true).setMaxLength(4)
  ));
  if (type === 'mesaj' || type === 'karma') rows.push(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('task_message_count').setLabel('Gerekli Mesaj Sayısı')
      .setStyle(TextInputStyle.Short).setPlaceholder('50').setRequired(true).setMaxLength(5)
  ));
  if (type === 'partnerlik') rows.push(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('task_partnership_count').setLabel('Kaç Partnerlik Yapılmalı?')
      .setStyle(TextInputStyle.Short).setPlaceholder('5').setRequired(true).setMaxLength(4)
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('task_start_date').setLabel('Başlangıç Tarihi: GG.AA.YYYY (isteğe bağlı)')
      .setStyle(TextInputStyle.Short).setPlaceholder('01.05.2026').setRequired(false).setMaxLength(10)
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('task_due').setLabel('Bitiş Tarihi: GG.AA.YYYY (isteğe bağlı)')
      .setStyle(TextInputStyle.Short).setPlaceholder('31.05.2026').setRequired(false).setMaxLength(10)
  ));

  modal.addComponents(...rows);
  return modal;
}

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

      const modal = new ModalBuilder()
        .setCustomId(`task_edit_modal_${taskId}`)
        .setTitle(`✏️ Görev #${taskId} Düzenle`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('task_title').setLabel('Başlık')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(task.title)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('task_description').setLabel('Açıklama (isteğe bağlı)')
            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400).setValue(task.description ?? '')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('task_start_date').setLabel('Başlangıç Tarihi GG.AA.YYYY (isteğe bağlı)')
            .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setValue(task.start_date ?? '')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('task_due').setLabel('Bitiş Tarihi GG.AA.YYYY (isteğe bağlı)')
            .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10).setValue(task.due_date ?? '')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('task_points').setLabel('Ödül Puanı')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(String(task.points ?? 25))
        ),
      );

      return interaction.showModal(modal);
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
      if (promoRole) {
        try {
          const targetUser = await interaction.client.users.fetch(uid);
          await targetUser.send({
            embeds: [new EmbedBuilder()
              .setColor(0xffd700)
              .setTitle('🎉 Terfi Şartlarını Karşıladın!')
              .setDescription(`**${task.title}** görevi tamamlandı. <@&${promoRole.role_id}> için terfi şartlarını karşıladın! Sunucuya gidip "Terfi Talep Et" butonuna bas.`)
              .setTimestamp()],
          });
        } catch {}
      }

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
  },
};

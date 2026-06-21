const { pool } = require('./database');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const PRIORITY_CONFIG = {
  yüksek: { emoji: '🔴', color: 0xff4444 },
  orta:   { emoji: '🟡', color: 0xffcc00 },
  düşük:  { emoji: '🟢', color: 0x44cc88 },
};

const STATUS_CONFIG = {
  bekliyor:         { emoji: '⏳', label: 'Bekliyor' },
  onay_bekleniyor:  { emoji: '🕐', label: 'Onay Bekleniyor' },
  devam:            { emoji: '🔄', label: 'Devam Ediyor' },
  tamamlandı:       { emoji: '✅', label: 'Tamamlandı' },
  iptal:            { emoji: '❌', label: 'İptal' },
  isleniyor:        { emoji: '⚙️', label: 'İşleniyor' },
};

// "ses:30,mesaj:50" → { voice_minutes: 30, messages: 50 }
function parseRequirements(raw) {
  if (!raw?.trim()) return {};
  const req = {};
  for (const part of raw.toLowerCase().split(',').map(p => p.trim())) {
    const [key, val] = part.split(':').map(s => s.trim());
    const num = parseInt(val);
    if (isNaN(num)) continue;
    if (key === 'ses') req.voice_minutes = num;
    else if (key === 'mesaj') req.messages = num;
    else if (key === 'partnerlik') req.partnership_count = num;
  }
  return req;
}

function formatRequirements(req) {
  if (!req || !Object.keys(req).length) return '*Gereksinim yok*';
  const parts = [];
  if (req.voice_minutes)     parts.push(`🎙️ ${req.voice_minutes} ses puanı (mic açık)`);
  if (req.messages)          parts.push(`💬 ${req.messages} mesaj puanı`);
  if (req.partnership_count) parts.push(`🤝 ${req.partnership_count} partnerlik`);
  return parts.join(' + ');
}

async function checkRequirements(guildId, userId, assignment, task) {
  const req = task.requirements ?? {};
  if (!Object.keys(req).length) return { met: true, progress: [] };

  // Bug fix: start_date varsa assigned_at ile karşılaştır, hangisi daha geçse onu kullan
  let since = new Date(assignment.assigned_at);
  if (task.start_date) {
    const parts = task.start_date.split('.');
    if (parts.length === 3) {
      const startDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      if (!isNaN(startDate) && startDate > since) since = startDate;
    }
  }
  const progress = [];
  let allMet = true;

  // İsteğe bağlı görevler: AYNI TÜRDE zorunlu görev beklenirken geçen süreyi sayma
  // Örnek: zorunlu ses görevi varken isteğe bağlı ses görevi sayılmaz
  //        ama zorunlu partnerlik/ses varken isteğe bağlı mesaj görevi sayılır
  const isOptional = !task.is_mandatory;

  // Hangi türde aktif zorunlu görev var? (dışlama kuralı için)
  let hasVoiceMandatory = false;
  let hasMsgMandatory = false;
  let hasPartnerMandatory = false;
  if (isOptional) {
    const mRes = await pool.query(
      `SELECT t2.type FROM task_assignments ta2
       JOIN tasks t2 ON t2.id = ta2.task_id
       WHERE ta2.user_id = $2 AND t2.guild_id = $1
         AND t2.is_mandatory = true
         AND ta2.status = 'bekliyor'`,
      [guildId, userId]
    );
    for (const row of mRes.rows) {
      if (row.type === 'ses' || row.type === 'karma') hasVoiceMandatory = true;
      if (row.type === 'mesaj' || row.type === 'karma') hasMsgMandatory = true;
      if (row.type === 'partnerlik') hasPartnerMandatory = true;
    }
  }

  const mandatoryExcludeVoice = hasVoiceMandatory ? `
    AND NOT EXISTS (
      SELECT 1 FROM task_assignments ta2
      JOIN tasks t2 ON t2.id = ta2.task_id
      WHERE ta2.user_id = $2 AND t2.guild_id = $1
        AND t2.is_mandatory = true
        AND t2.type IN ('ses', 'karma')
        AND ta2.status = 'bekliyor'
        AND ta2.assigned_at <= vl.joined_at
    )` : '';
  const mandatoryExcludeMsg = hasMsgMandatory ? `
    AND NOT EXISTS (
      SELECT 1 FROM task_assignments ta2
      JOIN tasks t2 ON t2.id = ta2.task_id
      WHERE ta2.user_id = $2 AND t2.guild_id = $1
        AND t2.is_mandatory = true
        AND t2.type IN ('mesaj', 'karma')
        AND ta2.status = 'bekliyor'
        AND ta2.assigned_at <= ml.created_at
    )` : '';

  if (req.voice_minutes) {
    const { getScoreConfig } = require('./activityTracker');
    const cfg = await getScoreConfig(guildId);
    const res = await pool.query(
      `SELECT COALESCE(SUM(vl.active_seconds), 0) AS total
       FROM voice_logs vl
       WHERE vl.guild_id = $1 AND vl.user_id = $2 AND vl.joined_at >= $3
       ${mandatoryExcludeVoice}`,
      [guildId, userId, since]
    );
    const doneScore = Math.round((Number(res.rows[0].total) / 60) * cfg.voice_per_min * 100) / 100;
    const met = doneScore >= req.voice_minutes;
    if (!met) allMet = false;
    const blockedNote = isOptional ? (hasVoiceMandatory ? '\n   🚫 *Sayılmıyor — zorunlu ses görevi tamamlanana kadar bekleniyor*' : '\n   ✅ *Sayılıyor*') : '';
    progress.push(`🎙️ Ses puanı: ${doneScore}/${req.voice_minutes} ${met ? '✅' : '❌'}${blockedNote}`);
  }

  if (req.messages) {
    const res = await pool.query(
      `SELECT COALESCE(SUM(ml.score), 0) AS total
       FROM message_logs ml
       WHERE ml.guild_id = $1 AND ml.user_id = $2 AND ml.created_at >= $3
       ${mandatoryExcludeMsg}`,
      [guildId, userId, since]
    );
    const doneScore = Math.round(Number(res.rows[0].total) * 100) / 100;
    const met = doneScore >= req.messages;
    if (!met) allMet = false;
    const blockedNote = isOptional ? (hasMsgMandatory ? '\n   🚫 *Sayılmıyor — zorunlu mesaj görevi tamamlanana kadar bekleniyor*' : '\n   ✅ *Sayılıyor*') : '';
    progress.push(`💬 Mesaj puanı: ${doneScore}/${req.messages} ${met ? '✅' : '❌'}${blockedNote}`);
  }

  if (req.partnership_count) {
    const mandatoryExcludePartnership = hasPartnerMandatory ? `
      AND NOT EXISTS (
        SELECT 1 FROM task_assignments ta2
        JOIN tasks t2 ON t2.id = ta2.task_id
        WHERE ta2.user_id = $2 AND t2.guild_id = $1
          AND t2.is_mandatory = true
          AND t2.type = 'partnerlik'
          AND ta2.status = 'bekliyor'
          AND ta2.assigned_at <= pl.created_at
      )` : '';
    const res = await pool.query(
      `SELECT COUNT(*) AS total FROM partnership_logs pl
       WHERE pl.guild_id = $1 AND pl.user_id = $2 AND pl.created_at >= $3
       ${mandatoryExcludePartnership}`,
      [guildId, userId, since]
    );
    const done = parseInt(res.rows[0].total);
    const met = done >= req.partnership_count;
    if (!met) allMet = false;
    const blockedNote = isOptional ? (hasPartnerMandatory ? '\n   🚫 *Sayılmıyor — zorunlu partnerlik görevi tamamlanana kadar bekleniyor*' : '\n   ✅ *Sayılıyor*') : '';
    progress.push(`🤝 Partnerlik: ${done}/${req.partnership_count} ${met ? '✅' : '❌'}${blockedNote}`);
  }

  return { met: allMet, progress };
}

// ── Partnerlik logu ekle ──────────────────────────────────────
async function logPartnership(guildId, userId, username, messageId) {
  await pool.query(
    `INSERT INTO partnership_logs (guild_id, user_id, username, message_id) VALUES ($1, $2, $3, $4)`,
    [guildId, userId, username, messageId]
  );
}

// ── Partnerlik mesajı gelince atanan görevleri kontrol et / tamamla ──
async function checkPartnershipTasks(client, guildId, userId, username, guild) {
  const { addTaskPoints, addMandatoryTaskPoints } = require('./activityTracker');
  const { calcTaskXP, completeMandatoryFromTask, checkPromotion } = require('./roleSystem');
  const PRIORITY_POINTS = { yüksek: 50, orta: 25, düşük: 10 };

  // Bu kullanıcıya atanmış bekliyor durumdaki partnerlik görevleri
  const res = await pool.query(`
    SELECT ta.*, t.requirements, t.points, t.priority, t.is_mandatory, t.xp_limit,
           t.original_task_id, t.category, t.guild_id
    FROM task_assignments ta
    JOIN tasks t ON t.id = ta.task_id
    WHERE ta.user_id = $1 AND t.guild_id = $2
      AND ta.status = 'bekliyor'
      AND t.type = 'partnerlik'
      AND t.status != 'iptal'
  `, [userId, guildId]);

  for (const row of res.rows) {
    const assignment = { assigned_at: row.assigned_at, task_id: row.task_id };
    const task = {
      requirements: row.requirements ?? {},
      points: row.points,
      priority: row.priority,
      is_mandatory: row.is_mandatory,
      xp_limit: row.xp_limit,
      original_task_id: row.original_task_id,
      category: row.category,
      id: row.task_id,
    };

    const { met } = await checkRequirements(guildId, userId, assignment, task);
    if (!met) continue;

    // Atomic tamamla — status hâlâ 'bekliyor' ise güncelle (race condition koruması)
    const updateRes = await pool.query(
      `UPDATE task_assignments SET status = 'tamamlandı', completed_at = NOW()
       WHERE task_id = $1 AND user_id = $2 AND status = 'bekliyor'
       RETURNING *`,
      [row.task_id, userId]
    );
    if (!updateRes.rows.length) continue; // Zaten tamamlanmış, atla

    const basePoints = task.points ?? PRIORITY_POINTS[task.priority] ?? 25;
    let earnedPoints = 0;
    let pointMsg = '';

    try {
      if (task.is_mandatory === true) {
        // Zorunlu: XP limit kontrolü
        const xpLimitResult = await checkXpLimit(task, userId).catch(() => ({ limited: false }));
        if (xpLimitResult.limited) {
          pointMsg = 'Tamamlama limiti doldu — puan verilmedi';
        } else {
          const { finalPoints } = await calcTaskXP(guildId, guild, userId, basePoints);
          earnedPoints = finalPoints;
          await addMandatoryTaskPoints(guildId, userId, username, finalPoints);
          const mandRes = await completeMandatoryFromTask(guildId, userId, username);
          // Streak sıfırlandı (DM devre dışı)
          pointMsg = `+${finalPoints} puan`;
        }
      } else {
        // İsteğe bağlı: XP limit + kategori cap kontrolü
        const xpLimitResult = await checkXpLimit(task, userId).catch(() => ({ limited: false }));
        if (xpLimitResult.limited) {
          pointMsg = 'Tamamlama limiti doldu — puan verilmedi';
        } else {
          let capped = false;
          if (task.category) {
            const capResult = await checkCategoryCap(guildId, userId, task.category).catch(() => ({ capped: false }));
            if (capResult.capped) {
              capped = true;
              pointMsg = `${task.category} kategorisi doldu — puan verilmedi`;
            }
          }
          if (!capped) {
            const { finalPoints, overLimit } = await calcTaskXP(guildId, guild, userId, basePoints);
            earnedPoints = finalPoints;
            await addTaskPoints(guildId, userId, username, finalPoints);
            pointMsg = `+${finalPoints} puan${overLimit ? ' (%60)' : ''}`;
          }
        }
      }
    } catch (err) {
      console.error('[checkPartnershipTasks XP]', err);
    }

    // Zorunlu görevler: tüm atamalar tamamlandıysa task-level'ı da kapat
    if (task.is_mandatory === true) {
      try {
        const allAssignments = await getTaskProgress(row.task_id);
        if (allAssignments.every(a => a.status === 'tamamlandı')) {
          await updateTask(guildId, row.task_id, { status: 'tamamlandı' });
        }
      } catch {}
    }

    // Terfi kontrolü
    try {
      await checkPromotion(guildId, guild, userId, username);
    } catch {}
  }
}

async function getConfig(guildId, key) {
  const res = await pool.query(`SELECT value FROM guild_config WHERE guild_id = $1 AND key = $2`, [guildId, key]);
  return res.rows[0]?.value ?? null;
}

async function setConfig(guildId, key, value) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (guild_id, key) DO UPDATE SET value = $3`,
    [guildId, key, value]
  );
}

async function createTask({ guildId, title, description, priority, points, startDate, dueDate, requirements, assignedRoles, createdById, createdByUsername, recurrence = null, isMandatory = false, category = null, xpLimit = null, originalTaskId = null, isPrivate = false, type = null }) {
  const req = parseRequirements(requirements);
  const rolesJson = JSON.stringify(assignedRoles ?? []);
  const nextRec = recurrence ? calcNextRecurrence(recurrence) : null;

  const res = await pool.query(`
    INSERT INTO tasks (guild_id, title, description, priority, points, start_date, due_date, requirements, assigned_role_ids, created_by_id, created_by_username, recurrence, next_recurrence, is_mandatory, category, xp_limit, original_task_id, is_private, type)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id
  `, [guildId, title, description ?? null, priority, points ?? 25, startDate ?? null, dueDate ?? null, JSON.stringify(req), rolesJson, createdById, createdByUsername, recurrence, nextRec, isMandatory, category ?? null, xpLimit ?? null, originalTaskId ?? null, isPrivate, type ?? null]);

  return res.rows[0].id;
}

async function assignUsersToTask(taskId, members) {
  for (const member of members) {
    const username = member.user?.username ?? member.username ?? 'bilinmiyor';
    await pool.query(`
      INSERT INTO task_assignments (task_id, user_id, username)
      VALUES ($1, $2, $3) ON CONFLICT (task_id, user_id) DO NOTHING
    `, [taskId, member.id, username]);
  }
}

async function getTask(guildId, id) {
  const res = await pool.query(`SELECT * FROM tasks WHERE guild_id = $1 AND id = $2`, [guildId, id]);
  return res.rows[0] ?? null;
}

const ALLOWED_TASK_COLUMNS = new Set([
  'title', 'description', 'priority', 'points', 'status',
  'start_date', 'due_date', 'message_id', 'channel_id',
  'recurrence', 'next_recurrence', 'is_mandatory', 'category',
  'xp_limit', 'is_private', 'requirements', 'assigned_role_ids',
]);
async function updateTask(guildId, id, fields) {
  const safeFields = Object.fromEntries(Object.entries(fields).filter(([k]) => ALLOWED_TASK_COLUMNS.has(k)));
  if (!Object.keys(safeFields).length) return;
  const sets = Object.keys(safeFields).map((k, i) => `${k} = $${i + 3}`).join(', ');
  await pool.query(`UPDATE tasks SET ${sets}, updated_at = NOW() WHERE guild_id = $1 AND id = $2`, [guildId, id, ...Object.values(safeFields)]);
}

async function getAssignment(taskId, userId) {
  const res = await pool.query(
    `SELECT * FROM task_assignments WHERE task_id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return res.rows[0] ?? null;
}

const ALLOWED_ASSIGNMENT_COLUMNS = new Set(['status', 'completed_at', 'username']);
async function updateAssignment(taskId, userId, fields) {
  const safeFields = Object.fromEntries(Object.entries(fields).filter(([k]) => ALLOWED_ASSIGNMENT_COLUMNS.has(k)));
  if (!Object.keys(safeFields).length) return;
  const sets = Object.keys(safeFields).map((k, i) => `${k} = $${i + 3}`).join(', ');
  await pool.query(
    `UPDATE task_assignments SET ${sets} WHERE task_id = $1 AND user_id = $2`,
    [taskId, userId, ...Object.values(safeFields)]
  );
}

async function getTaskProgress(taskId) {
  const res = await pool.query(
    `SELECT status, username, user_id FROM task_assignments WHERE task_id = $1 ORDER BY assigned_at`,
    [taskId]
  );
  return res.rows;
}

async function getAllTasks(guildId, status = null, userId = null, { search = null, category = null, priority = null } = {}) {
  const params = [guildId];
  const conditions = ['t.guild_id = $1'];

  if (status)   { params.push(status);   conditions.push(`t.status = $${params.length}`); }
  if (category) { params.push(category); conditions.push(`t.category = $${params.length}`); }
  if (priority) { params.push(priority); conditions.push(`t.priority = $${params.length}`); }
  if (search)   { params.push(`%${search}%`); conditions.push(`t.title ILIKE $${params.length}`); }

  if (userId) {
    params.push(userId);
    conditions.push(`ta.user_id = $${params.length}`);
    const res = await pool.query(`
      SELECT t.* FROM tasks t
      JOIN task_assignments ta ON ta.task_id = t.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.created_at DESC LIMIT 25
    `, params);
    return res.rows;
  }

  const res = await pool.query(`
    SELECT t.* FROM tasks t
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.created_at DESC LIMIT 25
  `, params);
  return res.rows;
}

// ── Görev Notları ─────────────────────────────────────────────
async function createTaskNote(taskId, userId, username, content) {
  await pool.query(
    `INSERT INTO task_notes (task_id, user_id, username, content) VALUES ($1, $2, $3, $4)`,
    [taskId, userId, username, content]
  );
}

async function getTaskNotes(taskId, limit = 3) {
  const res = await pool.query(
    `SELECT * FROM task_notes WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [taskId, limit]
  );
  return res.rows;
}

// ── Şablonlar ─────────────────────────────────────────────────
async function saveTemplate({ guildId, name, type, priority, points, description, requirements, createdById, createdByUsername, isMandatory = false, category = null, xpLimit = null, isPrivate = false, recurrence = null }) {
  // Not: task_templates tablosunda şu kolonlar gereklidir:
  // is_mandatory BOOLEAN, category TEXT, xp_limit INT, is_private BOOLEAN, recurrence TEXT
  // Migration: ALTER TABLE task_templates ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN DEFAULT FALSE,
  //   ADD COLUMN IF NOT EXISTS category TEXT, ADD COLUMN IF NOT EXISTS xp_limit INT,
  //   ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE, ADD COLUMN IF NOT EXISTS recurrence TEXT;
  const res = await pool.query(
    `INSERT INTO task_templates (guild_id, name, type, priority, points, description, requirements, created_by_id, created_by_username, is_mandatory, category, xp_limit, is_private, recurrence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [guildId, name, type, priority, points ?? 25, description ?? null, requirements ?? null, createdById, createdByUsername, isMandatory, category ?? null, xpLimit ?? null, isPrivate, recurrence ?? null]
  );
  return res.rows[0].id;
}

async function getTemplates(guildId) {
  const res = await pool.query(`SELECT * FROM task_templates WHERE guild_id = $1 ORDER BY created_at DESC`, [guildId]);
  return res.rows;
}

async function getTemplate(guildId, id) {
  const res = await pool.query(`SELECT * FROM task_templates WHERE guild_id = $1 AND id = $2`, [guildId, id]);
  return res.rows[0] ?? null;
}

async function deleteTemplate(guildId, id) {
  await pool.query(`DELETE FROM task_templates WHERE guild_id = $1 AND id = $2`, [guildId, id]);
}

// ── Görev Kategorileri ────────────────────────────────────────
async function addCategory(guildId, name, totalCap) {
  await pool.query(`
    INSERT INTO task_categories (guild_id, name, total_cap)
    VALUES ($1, $2, $3)
    ON CONFLICT (guild_id, name) DO UPDATE SET total_cap = $3
  `, [guildId, name.toLowerCase(), totalCap]);
}

async function removeCategory(guildId, name) {
  await pool.query(`DELETE FROM task_categories WHERE guild_id = $1 AND name = $2`, [guildId, name.toLowerCase()]);
}

async function getCategories(guildId) {
  const res = await pool.query(`SELECT * FROM task_categories WHERE guild_id = $1 ORDER BY name`, [guildId]);
  return res.rows;
}

// Kullanıcının bu kategorideki toplam tamamlama sayısını kontrol eder
async function checkCategoryCap(guildId, userId, categoryName) {
  const catRes = await pool.query(`SELECT total_cap FROM task_categories WHERE guild_id = $1 AND name = $2`, [guildId, categoryName.toLowerCase()]);
  if (!catRes.rows[0]) return { capped: false, total: 0, totalCap: null };
  const totalCap = catRes.rows[0].total_cap;

  const countRes = await pool.query(`
    SELECT COUNT(*) AS total
    FROM task_assignments ta
    JOIN tasks t ON t.id = ta.task_id
    WHERE t.guild_id = $1 AND ta.user_id = $2
      AND t.category = $3 AND t.is_mandatory IS NOT TRUE
      AND ta.status = 'tamamlandı'
  `, [guildId, userId, categoryName.toLowerCase()]);

  const total = parseInt(countRes.rows[0].total);
  return { capped: total >= totalCap, total, totalCap };
}

// Kullanıcının bu görev serisinden kaç kez XP aldığını kontrol eder
async function checkXpLimit(task, userId) {
  if (!task.xp_limit) return { limited: false, count: 0, limit: null }; // sınırsız

  // Orijinal task ID — bu task bir tekrarlama ise original_task_id'yi, değilse kendi id'sini kullan
  const rootId = task.original_task_id ?? task.id;

  const res = await pool.query(`
    SELECT COUNT(*) AS total
    FROM task_assignments ta
    JOIN tasks t ON t.id = ta.task_id
    WHERE ta.user_id = $1
      AND ta.status = 'tamamlandı'
      AND (t.id = $2 OR t.original_task_id = $2)
  `, [userId, rootId]);

  const count = parseInt(res.rows[0].total);
  return { limited: count >= task.xp_limit, count, limit: task.xp_limit };
}

// ── Tekrarlama ────────────────────────────────────────────────
function calcNextRecurrence(recurrence) {
  const now = new Date();
  if (recurrence === 'gunluk')  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (recurrence === 'haftalik') return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (recurrence === 'aylik')   return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return null;
}

async function checkRecurringTasks(client) {
  try {
  // Bug fix: 'tamamlandı' görevler atlanır — dönem kapandıktan sonra klon devam eder
  const res = await pool.query(
    `SELECT * FROM tasks WHERE recurrence IS NOT NULL AND next_recurrence <= NOW() AND status NOT IN ('iptal', 'tamamlandı')`
  );
  for (const task of res.rows) {
    try {
      const guildId = task.guild_id;
      // Guild'i erken al — birden fazla yerde kullanılacak
      const guild = client.guilds.cache.get(guildId);

      const reqStr = task.requirements && typeof task.requirements === 'object' && Object.keys(task.requirements).length
        ? Object.entries(task.requirements).map(([k, v]) => {
            if (k === 'voice_minutes')     return `ses:${v}`;
            if (k === 'messages')          return `mesaj:${v}`;
            if (k === 'partnership_count') return `partnerlik:${v}`;
            return null; // bilinmeyen key'i atla
          }).filter(Boolean).join(',')
        : null;

      const newId = await createTask({
        guildId, title: task.title, description: task.description,
        priority: task.priority, points: task.points, startDate: null, dueDate: null,
        requirements: reqStr, assignedRoles: task.assigned_role_ids ?? [],
        createdById: task.created_by_id, createdByUsername: task.created_by_username,
        recurrence: task.recurrence,
        isMandatory: task.is_mandatory ?? false,
        category: task.category ?? null,
        xpLimit: task.xp_limit ?? null,
        isPrivate: task.is_private ?? false,
        originalTaskId: task.original_task_id ?? task.id, // Serinin kök ID'si
        type: task.type ?? null,
      });

      const assignedRoles = task.assigned_role_ids ?? [];
      const roleIds = new Set(assignedRoles.map(r => r.id));

      // Tekrarlayan görevler her dönemde otomatik atanır; xp_limit dolmuşlar atlanır
      if (roleIds.size > 0 && guild) {
        const allMembers = await guild.members.fetch();
        let members = [...allMembers.values()].filter(m => m.roles.cache.some(r => roleIds.has(r.id)));

        if (task.xp_limit && members.length) {
          const rootId = task.original_task_id ?? task.id;
          const limitChecks = await Promise.all(members.map(async m => {
            const r = await pool.query(`
              SELECT COUNT(*) AS total FROM task_assignments ta
              JOIN tasks t ON t.id = ta.task_id
              WHERE ta.user_id = $1 AND ta.status = 'tamamlandı'
                AND (t.id = $2 OR t.original_task_id = $2)
            `, [m.id, rootId]);
            const count = parseInt(r.rows[0].total);
            return count < task.xp_limit ? m : null;
          }));
          members = limitChecks.filter(Boolean);
        }

        if (members.length) await assignUsersToTask(newId, members);
      }

      const tasksChannelId = await getConfig(guildId, 'task_tasks_channel');
      if (tasksChannelId && guild) {
        const newTask = await getTask(guildId, newId);
        const embed = await buildTaskEmbed(newTask);
        const buttons = buildTaskButtons(newId, newTask.status, newTask);
        const isMandatory = task.is_mandatory === true;
        const recLabel = { gunluk: 'Günlük', haftalik: 'Haftalık', aylik: 'Aylık' }[task.recurrence] ?? task.recurrence;
        const roleMentions = assignedRoles.map(r => `<@&${r.id}>`).join(' ');

        // Yeni dönem bildirimi
        const notifEmbed = new EmbedBuilder()
          .setColor(isMandatory ? 0xff9900 : 0x9966ff)
          .setTitle(`🔁 Yeni ${recLabel} Dönem Başladı — ${task.title}`)
          .setDescription(
            assignedRoles.length
              ? `${roleMentions}\nBu dönem görevi yenilendi. Yukarıdaki görev kartından tamamlayın.`
              : 'Bu dönem görevi yenilendi.'
          )
          .setTimestamp();

        const ch = guild.channels.cache.get(tasksChannelId);
        if (ch) {
          // Önce bildirim mesajı
          await ch.send({
            content: assignedRoles.length ? roleMentions : null,
            embeds: [notifEmbed],
            allowedMentions: { roles: assignedRoles.map(r => r.id) },
          }).catch(() => {});

          // Sonra yeni görev embed'i
          const msg = await ch.send({
            embeds: [embed],
            components: buttons ? [buttons] : [],
          });
          await updateTask(guildId, newId, { message_id: msg.id, channel_id: tasksChannelId });
        }
      }

      // Bug fix: Mevcut dönem görevini kapat — klon bir sonraki dönemi devralır
      // Sorgu filtresi 'tamamlandı' içerdiği için bu görev bir daha tetiklenmez
      await pool.query(`UPDATE tasks SET status = 'tamamlandı', updated_at = NOW() WHERE id = $1`, [task.id]);

      // Eski embed'i güncelle (butonları kaldır, dönem bitti mesajı)
      if (task.message_id && task.channel_id && guild) {
        const ch = guild.channels.cache.get(task.channel_id);
        if (ch) {
          const msg = await ch.messages.fetch(task.message_id).catch(() => null);
          if (msg) {
            const expiredTask = await getTask(guildId, task.id);
            const expiredEmbed = await buildTaskEmbed(expiredTask);
            await msg.edit({ content: `✅ **Bu görev tamamlandı.**`, embeds: [expiredEmbed], components: [] }).catch(() => {});
          }
        }
      }

      console.log(`🔁 Tekrarlayan görev #${task.id} → yeni #${newId} oluşturuldu`);
    } catch (err) {
      console.error(`[checkRecurringTasks] #${task.id}:`, err.message);
    }
  }
  } catch (err) {
    console.error('[checkRecurringTasks] DB hatası:', err.message);
  }
}

async function buildTaskEmbed(task) {
  const prio = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.orta;
  const stat = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.bekliyor;
  const createdTs = Math.floor(new Date(task.created_at).getTime() / 1000);

  const assignments = await getTaskProgress(task.id);
  const total = assignments.length;
  const completed = assignments.filter(a => a.status === 'tamamlandı').length;

  const roles = task.assigned_role_ids ?? [];
  const roleStr = roles.length ? roles.map(r => `<@&${r.id}>`).join(', ') : '*Yok*';

  // Kişi listesi (max 10 göster)
  const STATUS_EMOJI = { bekliyor: '⏳', onay_bekleniyor: '🕐', devam: '🔄', tamamlandı: '✅', iptal: '❌', isleniyor: '⚙️' };
  const assigneeList = assignments.slice(0, 10)
    .map(a => `${STATUS_EMOJI[a.status] ?? '⏳'} <@${a.user_id}>`)
    .join('\n') || '*Henüz kimse atanmadı*';

  const embed = new EmbedBuilder()
    .setTitle(`📌 ${task.title}`)
    .setColor(task.status === 'tamamlandı' ? 0x44cc88 : task.status === 'iptal' ? 0x888888 : prio.color)
    .addFields(
      { name: '🏷️ Durum', value: `${stat.emoji} ${stat.label}`, inline: true },
      { name: '⚡ Öncelik', value: `${prio.emoji} ${(task.priority ?? 'orta').charAt(0).toUpperCase() + (task.priority ?? 'orta').slice(1)}`, inline: true },
      { name: '📅 Başlangıç', value: task.start_date ?? '*Belirtilmedi*', inline: true },
      { name: '⏰ Bitiş', value: task.due_date ?? '*Belirtilmedi*', inline: true },
      { name: '🎭 Atanan Roller', value: roleStr, inline: false },
      { name: '📋 Gereksinimler', value: formatRequirements(task.requirements), inline: false },
      { name: '🏆 Ödül Puanı', value: `${task.points ?? 25} puan`, inline: true },
      { name: '📂 Kategori', value: task.category ?? '*Kategorisiz*', inline: true },
      { name: '🔖 Tür',        value: task.is_mandatory ? '⚠️ Zorunlu' : '🎯 İsteğe Bağlı',                                    inline: true },
      { name: '🔂 XP Limiti', value: task.xp_limit ? `${task.xp_limit} kez` : 'Sınırsız',                                       inline: true },
      { name: '🔁 Tekrarlama', value: task.recurrence ? ({ gunluk: 'Günlük', haftalik: 'Haftalık', aylik: 'Aylık' }[task.recurrence] ?? task.recurrence) : '*Yok*', inline: true },
      { name: `👥 İlerleme ${total ? `(${completed}/${total})` : ''}`, value: assigneeList, inline: false },
      { name: '✍️ Oluşturan', value: `<@${task.created_by_id}>`, inline: true },
    )
    .setFooter({ text: `Görev #${task.id} • Oluşturuldu` })
    .setTimestamp(new Date(task.created_at));

  if (task.description) embed.setDescription(task.description);

  const notes = await getTaskNotes(task.id, 3);
  if (notes.length) {
    const noteLines = notes.map(n => {
      const ts = Math.floor(new Date(n.created_at).getTime() / 1000);
      return `<@${n.user_id}> · <t:${ts}:R>\n*${n.content.slice(0, 100)}*`;
    }).join('\n\n');
    embed.addFields({ name: `📝 Notlar`, value: noteLines, inline: false });
  }

  return embed;
}

function buildTaskButtons(taskId, status, task = null) {
  if (status === 'iptal') return null;

  // Üstlen butonu sadece: isteğe bağlı VE tekrarlamayan görevlerde çıkar
  // Tekrarlayan isteğe bağlı görevler her dönem otomatik atanır → Üstlen gerekmez
  const isOptional  = task && task.is_mandatory !== true;
  const isRecurring = task && task.recurrence != null;
  const showClaim   = isOptional && !isRecurring;

  const buttons = [];

  if (status !== 'tamamlandı') {
    if (showClaim) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`task_claim_${taskId}`)
          .setLabel('Üstlen')
          .setEmoji('🙋')
          .setStyle(ButtonStyle.Primary),
      );
    }
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`task_complete_${taskId}`)
        .setLabel('Tamamlandı')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`task_cancel_${taskId}`)
        .setLabel('İptal Et')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`task_note_${taskId}`)
      .setLabel('Not Ekle')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary),
  );

  return new ActionRowBuilder().addComponents(...buttons);
}

// ── Admin log kanalı ──────────────────────────────────────────
async function sendTaskLog(client, guildId, embed) {
  try {
    const channelId = await getConfig(guildId, 'task_log_channel');
    if (!channelId) return;
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;
    // Bot'un o kanalda yazma yetkisi var mı?
    const me = channel.guild?.members?.me;
    if (me && !channel.permissionsFor(me)?.has('SendMessages')) {
      console.warn(`[sendTaskLog] Bot'un log kanalında (${channelId}) yazma yetkisi yok.`);
      return;
    }
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[sendTaskLog]', err.message);
  }
}

// ── Deadline hatırlatıcısı ────────────────────────────────────
async function checkDeadlines(client) {
  try {
    // Yarın (24 saat içinde) bitecek, henüz hatırlatılmamış aktif görevler
    const res = await pool.query(`
      SELECT t.*, gc.value AS tasks_channel_id
      FROM tasks t
      LEFT JOIN guild_config gc ON gc.guild_id = t.guild_id AND gc.key = 'task_tasks_channel'
      WHERE t.due_date IS NOT NULL
        AND t.status NOT IN ('tamamlandı', 'iptal')
        AND t.reminded_at IS NULL
        AND t.due_date ~ '^\d{2}\.\d{2}\.\d{4}$'
        AND TO_DATE(t.due_date, 'DD.MM.YYYY') BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '1 day'
    `);

    for (const task of res.rows) {
      try {
        const channelId = task.tasks_channel_id ?? await getConfig(task.guild_id, 'task_tasks_channel');
        if (!channelId) continue;
        const channel = client.channels.cache.get(channelId);
        if (!channel) continue;

        const assignments = await getTaskProgress(task.id);
        const pending = assignments.filter(a => a.status !== 'tamamlandı');
        const mentions = pending.map(a => `<@${a.user_id}>`).join(' ') || '';

        const embed = new EmbedBuilder()
          .setColor(0xff9900)
          .setTitle(`⏰ Son 24 Saat! — #${task.id} ${task.title}`)
          .setDescription(`Bu görevin bitiş tarihi: **${task.due_date}**\n${mentions ? `\n${mentions}` : ''}`)
          .setTimestamp();

        if (task.message_id) embed.addFields({ name: '🔗 Görev', value: `[Göreve git](https://discord.com/channels/${task.guild_id}/${channelId}/${task.message_id})`, inline: true });

        await channel.send({ content: mentions || null, embeds: [embed], allowedMentions: { users: pending.map(a => a.user_id) } });

        // reminded_at güncelle — bir daha hatırlatma gitmesin
        await pool.query(`UPDATE tasks SET reminded_at = NOW() WHERE id = $1`, [task.id]);
        console.log(`⏰ Deadline hatırlatıcısı gönderildi: Görev #${task.id}`);
      } catch (err) {
        console.error(`[checkDeadlines] #${task.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[checkDeadlines]', err.message);
  }
}

// ── Onay bekleyen atama fonksiyonları ─────────────────────────
async function getPendingApprovals(guildId) {
  const res = await pool.query(`
    SELECT ta.*, t.title, t.points, t.priority, t.is_mandatory, t.id AS task_id
    FROM task_assignments ta
    JOIN tasks t ON t.id = ta.task_id
    WHERE t.guild_id = $1 AND ta.status = 'onay_bekleniyor'
    ORDER BY ta.assigned_at DESC
  `, [guildId]);
  return res.rows;
}

// Spam engeli: task_id:user_id → bildirim zamanı (24 saat TTL)
const _notifiedCache = new Map();
setInterval(() => {
  const ttl = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [k, t] of _notifiedCache) if (now - t > ttl) _notifiedCache.delete(k);
}, 60 * 60 * 1000).unref();

// ── Görev gereksinimi karşılandığında score log kanalına bildir ─
async function notifyTaskReady(client, guildId, userId, username) {
  try {
    // Score log kanalı
    const logChRes = await pool.query(
      `SELECT value FROM guild_config WHERE guild_id = $1 AND key = 'points_log_channel'`,
      [guildId]
    );
    const logChId = logChRes.rows[0]?.value;
    if (!logChId) return;
    const logCh = client.channels.cache.get(logChId);
    if (!logCh) return;

    // Kullanıcının bekleyen görevlerini çek
    const tasks = await pool.query(`
      SELECT t.id, t.title, t.requirements, t.is_mandatory, t.start_date,
             ta.assigned_at, ta.status
      FROM task_assignments ta
      JOIN tasks t ON t.id = ta.task_id
      WHERE t.guild_id = $1 AND ta.user_id = $2
        AND ta.status = 'bekliyor' AND t.status = 'bekliyor'
    `, [guildId, userId]);

    for (const t of tasks.rows) {
      const req = t.requirements ?? {};
      if (!Object.keys(req).length) continue;

      const result = await checkRequirements(guildId, userId, t, t).catch(() => null);
      if (!result?.met) continue;

      // Spam engeli — memory cache (24 saat)
      const cacheKey = `${guildId}:${t.id}:${userId}`;
      if (_notifiedCache.has(cacheKey)) continue;
      _notifiedCache.set(cacheKey, Date.now());

      // Bildirim gönder
      const { EmbedBuilder } = require('discord.js');
      await logCh.send({
        embeds: [new EmbedBuilder()
          .setColor(0x44cc88)
          .setTitle('✅ Görev Tamamlanabilir')
          .setDescription(`<@${userId}> **#${t.id} ${t.title}** görevinin gereksinimlerini karşıladı!\nGörev kanalına giderek **Tamamlandı** butonuna basabilir.`)
          .setTimestamp()
        ],
      }).catch(() => {});
    }
  } catch {}
}

module.exports = {
  parseRequirements, formatRequirements, checkRequirements,
  notifyTaskReady,
  getConfig, setConfig,
  createTaskNote, getTaskNotes,
  saveTemplate, getTemplates, getTemplate, deleteTemplate,
  calcNextRecurrence, checkRecurringTasks, checkDeadlines,
  createTask, assignUsersToTask, updateTask, getTask, getAllTasks,
  getAssignment, updateAssignment, getTaskProgress,
  addCategory, removeCategory, getCategories, checkCategoryCap, checkXpLimit,
  buildTaskEmbed, buildTaskButtons,
  logPartnership, checkPartnershipTasks,
  sendTaskLog, getPendingApprovals,
};

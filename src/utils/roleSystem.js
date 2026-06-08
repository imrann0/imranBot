const { EmbedBuilder } = require('discord.js');
const { pool } = require('./database');
const { addResponsibilityPoints, activityScore, getUser: getActivityUser } = require('./activityTracker');

// ── Hafta bilgisi ─────────────────────────────────────────────
function getWeekInfo(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

// Bug fix: 53 haftalı yılları doğru yönetir
function getPrevWeekInfo() {
  const { week, year } = getWeekInfo();
  if (week === 1) {
    // Önceki yılın son ISO haftasını bul (28 Aralık her zaman son ISO haftasındadır)
    const dec28 = new Date(Date.UTC(year - 1, 11, 28));
    return getWeekInfo(dec28);
  }
  return { week: week - 1, year };
}

// ── Config ────────────────────────────────────────────────────
async function getCfg(guildId, key) {
  const res = await pool.query(
    `SELECT value FROM guild_config WHERE guild_id = $1 AND key = $2`,
    [guildId, key]
  );
  return res.rows[0]?.value ?? null;
}

async function setCfg(guildId, key, value) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, key) DO UPDATE SET value = $3`,
    [guildId, key, value]
  );
}

// ── Roller ────────────────────────────────────────────────────
async function addRole(guildId, roleId, roleName, opts) {
  await pool.query(`
    INSERT INTO rs_roles (guild_id, role_id, role_name, xp_required, responsibility_limit, xp_multiplier, weekly_tasks_required, task_period_weeks, position)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (guild_id, role_id) DO UPDATE SET
      role_name = $3, xp_required = $4, responsibility_limit = $5,
      xp_multiplier = $6, weekly_tasks_required = $7, task_period_weeks = $8, position = $9
  `, [guildId, roleId, roleName, opts.xpRequired, opts.responsibilityLimit,
      opts.multiplier, opts.weeklyTasksRequired, opts.taskPeriodWeeks, opts.position]);
}

async function removeRole(guildId, roleId) {
  await pool.query(`DELETE FROM rs_roles WHERE guild_id = $1 AND role_id = $2`, [guildId, roleId]);
}

async function getRoles(guildId) {
  const res = await pool.query(
    `SELECT * FROM rs_roles WHERE guild_id = $1 ORDER BY position ASC`, [guildId]
  );
  return res.rows;
}

async function getRoleForUser(guildId, member) {
  const roles = await getRoles(guildId);
  // Kullanıcının sahip olduğu en yüksek pozisyonlu sistem rolünü bul
  for (const r of [...roles].reverse()) {
    if (member.roles.cache.has(r.role_id)) return r;
  }
  return null;
}

// ── Sorumluluk türleri ────────────────────────────────────────
async function addType(guildId, name, xpPerCompletion, maxCap) {
  await pool.query(`
    INSERT INTO rs_types (guild_id, name, xp_per_completion, max_cap)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (guild_id, name) DO UPDATE SET xp_per_completion = $3, max_cap = $4
  `, [guildId, name, xpPerCompletion, maxCap]);
}

async function removeType(guildId, name) {
  await pool.query(`DELETE FROM rs_types WHERE guild_id = $1 AND name = $2`, [guildId, name]);
}

async function getTypes(guildId) {
  const res = await pool.query(`SELECT * FROM rs_types WHERE guild_id = $1 ORDER BY name`, [guildId]);
  return res.rows;
}

async function getType(guildId, name) {
  const res = await pool.query(`SELECT * FROM rs_types WHERE guild_id = $1 AND name = $2`, [guildId, name]);
  return res.rows[0] ?? null;
}

// ── Kullanıcı ─────────────────────────────────────────────────
async function ensureUser(guildId, userId, username) {
  await pool.query(`
    INSERT INTO rs_users (guild_id, user_id, username)
    VALUES ($1, $2, $3)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET username = $3
  `, [guildId, userId, username]);
}

async function getUser(guildId, userId) {
  const res = await pool.query(
    `SELECT * FROM rs_users WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]
  );
  return res.rows[0] ?? null;
}

// ⚠️ KULLANILMIYOR: current_xp kolonu hiçbir zaman güncellenmez.
// Gerçek skorlar activity tablosundaki 6 ayrı kategoride tutulur.
// Bu fonksiyonu çağırmayın; sadece geriye dönük uyumluluk için bırakıldı.
async function addXP(guildId, userId, xp) {
  await pool.query(`
    UPDATE rs_users SET current_xp = current_xp + $3
    WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId, xp]);
}

// ── Task puanı için çarpan hesapla (yazmaz, sadece döner) ────
// Caller bunu addTaskPoints'e geçirir — tek yazma noktası task_points kolonudur.
async function calcTaskXP(guildId, guild, userId, basePoints) {
  // Kullanıcının rolünü bul
  let roleData = null;
  let multiplier = 1.0;
  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      roleData = await getRoleForUser(guildId, member);
      if (roleData) multiplier = parseFloat(roleData.xp_multiplier);
    }
  }

  // Bu hafta kaç isteğe bağlı görev tamamlandı? (zorunlular limiti etkilemez)
  const weekStart = getWeekStart();
  const weekRes = await pool.query(`
    SELECT COUNT(*) AS total
    FROM task_assignments ta
    JOIN tasks t ON t.id = ta.task_id
    WHERE t.guild_id = $1 AND ta.user_id = $2
      AND (t.is_mandatory = FALSE OR t.is_mandatory IS NULL)
      AND ta.status = 'tamamlandı'
      AND ta.completed_at >= $3
  `, [guildId, userId, weekStart]);
  const weekTotal = parseInt(weekRes.rows[0].total);
  const limit = roleData?.responsibility_limit ?? 999;
  const overloadFactor = weekTotal >= limit ? 0.6 : 1.0; // Bug fix: >= ile completeResponsibility ile tutarlı

  const finalPoints = Math.round(basePoints * multiplier * overloadFactor);
  return { finalPoints, multiplier, overloadFactor, weekTotal, limit, overLimit: weekTotal >= limit };
}

// ── Task tamamlandıktan sonra terfi kontrolü yap ─────────────
async function checkPromotion(guildId, guild, userId, username) {
  const { week, year } = getWeekInfo();
  await ensureUser(guildId, userId, username);

  // Aktif hafta güncelle
  await pool.query(`
    UPDATE rs_users SET last_active_week = $3, last_active_year = $4, warning_count = 0
    WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId, week, year]);

  let roleData = null;
  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) roleData = await getRoleForUser(guildId, member);
  }
  if (!roleData) return null;

  const actUser = await getActivityUser(guildId, userId);
  const totalXP = actUser ? activityScore(actUser) : 0;
  const roles = await getRoles(guildId);
  const nextRole = roles.find(r => r.position === roleData.position + 1);
  if (!nextRole || totalXP < nextRole.xp_required) return null;

  // Bug fix: bu hafta VEYA geçen hafta zorunlu görev tamamlanmışsa terfiye izin ver
  const { week: prevWeek, year: prevYear } = getPrevWeekInfo();
  const mandRes = await pool.query(`
    SELECT completed FROM rs_mandatory
    WHERE guild_id = $1 AND user_id = $2 AND completed = TRUE
      AND ((week_number = $3 AND year = $4) OR (week_number = $5 AND year = $6))
  `, [guildId, userId, week, year, prevWeek, prevYear]);
  if (mandRes.rows.length === 0) return null;

  // weekly_tasks_required kontrolü: belirtilen süre içinde yeterli görev tamamlandı mı?
  const weeklyReq   = parseInt(nextRole.weekly_tasks_required ?? 0);
  const periodWeeks = parseInt(nextRole.task_period_weeks ?? 1);
  if (weeklyReq > 0) {
    const taskCountRes = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM task_assignments ta
      JOIN tasks t ON t.id = ta.task_id
      WHERE t.guild_id = $1 AND ta.user_id = $2
        AND ta.status = 'tamamlandı'
        AND ta.completed_at >= NOW() - (INTERVAL '1 week' * $3)
    `, [guildId, userId, periodWeeks]);
    const completedCount = parseInt(taskCountRes.rows[0].cnt ?? 0);
    if (completedCount < weeklyReq) return null;
  }

  return nextRole;
}

// Haftanın başlangıç tarihini (Pazartesi 00:00 UTC) döner
function getWeekStart() {
  const now = new Date();
  const day = now.getUTCDay() || 7;           // 1=Pzt … 7=Paz
  const diff = now.getUTCDate() - (day - 1);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), diff, 0, 0, 0));
}

// ── Sorumluluk tamamlama ──────────────────────────────────────
async function completeResponsibility(guildId, userId, username, typeName, count, approvedBy, guild) {
  const { week, year } = getWeekInfo();

  await ensureUser(guildId, userId, username);

  const type = await getType(guildId, typeName);
  if (!type) return { error: `"${typeName}" türü bulunamadı.` };

  // Kap kontrolü — bu türden toplam kaç kez yapıldı?
  const capRes = await pool.query(`
    SELECT COALESCE(SUM(count), 0) AS total
    FROM rs_completions WHERE guild_id = $1 AND user_id = $2 AND type_name = $3
  `, [guildId, userId, typeName]);
  const totalOfType = parseInt(capRes.rows[0].total);

  if (totalOfType >= type.max_cap) {
    return { error: `**${typeName}** türü için kap doldu (${type.max_cap}/${type.max_cap}). Bu türden artık XP kazanılamaz.` };
  }

  // Rol çarpanı
  let multiplier = 1.0;
  let roleData = null;
  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      roleData = await getRoleForUser(guildId, member);
      if (roleData) multiplier = parseFloat(roleData.xp_multiplier);
    }
  }

  // Bu hafta kaç görev tamamlandı? (limit kontrolü)
  const weekRes = await pool.query(`
    SELECT COALESCE(SUM(count), 0) AS total
    FROM rs_completions WHERE guild_id = $1 AND user_id = $2 AND week_number = $3 AND year = $4
  `, [guildId, userId, week, year]);
  const weekTotal = parseInt(weekRes.rows[0].total);
  const limit = roleData?.responsibility_limit ?? 999;

  let overloadFactor = 1.0;
  if (weekTotal >= limit) overloadFactor = 0.6; // Limiti aşmış → %60 XP

  const xpEarned = Math.round(type.xp_per_completion * count * multiplier * overloadFactor);

  // Kaydet
  await pool.query(`
    INSERT INTO rs_completions (guild_id, user_id, username, type_name, week_number, year, count, xp_earned, approved_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [guildId, userId, username, typeName, week, year, count, xpEarned, approvedBy]);

  // Birleşik puan havuzuna yaz (activity tablosu)
  await addResponsibilityPoints(guildId, userId, username, xpEarned);

  // Aktif hafta güncelle (streak için)
  await pool.query(`
    UPDATE rs_users SET last_active_week = $3, last_active_year = $4, warning_count = 0
    WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId, week, year]);

  // Terfi kontrolü — toplam XP activity tablosundan hesaplanır
  const actUser = await getActivityUser(guildId, userId);
  const totalXP = actUser ? activityScore(actUser) : 0;
  const roles = await getRoles(guildId);
  let promotionEligible = null;
  if (roleData) {
    const nextRole = roles.find(r => r.position === roleData.position + 1);
    if (nextRole && totalXP >= nextRole.xp_required) {
      // Bug fix: checkPromotion ile tutarlı — bu hafta VEYA geçen hafta zorunlu tamamlandıysa terfi hakkı var
      const { week: prevWeek, year: prevYear } = getPrevWeekInfo();
      const mandRes = await pool.query(`
        SELECT completed FROM rs_mandatory
        WHERE guild_id = $1 AND user_id = $2 AND completed = TRUE
          AND ((week_number = $3 AND year = $4) OR (week_number = $5 AND year = $6))
      `, [guildId, userId, week, year, prevWeek, prevYear]);
      if (mandRes.rows.length > 0) {
        // weekly_tasks_required kontrolü — checkPromotion ile tutarlı
        const weeklyReq   = parseInt(nextRole.weekly_tasks_required ?? 0);
        const periodWeeks = parseInt(nextRole.task_period_weeks ?? 1);
        let taskReqMet = true;
        if (weeklyReq > 0) {
          const taskCountRes = await pool.query(`
            SELECT COUNT(*) AS cnt
            FROM task_assignments ta JOIN tasks t ON t.id = ta.task_id
            WHERE t.guild_id = $1 AND ta.user_id = $2
              AND ta.status = 'tamamlandı'
              AND ta.completed_at >= NOW() - (INTERVAL '1 week' * $3)
          `, [guildId, userId, periodWeeks]);
          taskReqMet = parseInt(taskCountRes.rows[0].cnt ?? 0) >= weeklyReq;
        }
        if (taskReqMet) promotionEligible = nextRole;
      }
    }
  }

  return {
    xpEarned, multiplier, overloadFactor, weekTotal, limit,
    totalXP,
    capRemaining: Math.max(0, type.max_cap - totalOfType - count),
    promotionEligible,
    overLimit: weekTotal >= limit,
  };
}

// ── Zorunlu task tamamlandığında çağrılır ─────────────────────
async function completeMandatoryFromTask(guildId, userId, username) {
  const { week, year } = getWeekInfo();
  await ensureUser(guildId, userId, username);
  await pool.query(`
    INSERT INTO rs_mandatory (guild_id, user_id, username, week_number, year, completed, approved_by, approved_at)
    VALUES ($1, $2, $3, $4, $5, TRUE, 'sistem', NOW())
    ON CONFLICT (guild_id, user_id, week_number, year) DO UPDATE SET completed = TRUE, approved_at = NOW()
  `, [guildId, userId, username, week, year]);

  // Bug fix: 53 haftalı yılları destekler
  const user = await getUser(guildId, userId);
  const { week: prevWeek, year: prevYear } = getPrevWeekInfo();
  const oldStreak = user?.streak ?? 0;

  // Bu hafta zaten zorunlu görev tamamlandıysa streak'e dokunma (birden fazla zorunlu görev senaryosu)
  const alreadyThisWeek = user?.last_active_week === week && user?.last_active_year === year;
  if (alreadyThisWeek) {
    return { newStreak: oldStreak, streakBroken: false, oldStreak };
  }

  const wasActive = user?.last_active_week === prevWeek && user?.last_active_year === prevYear;
  const newStreak = wasActive ? oldStreak + 1 : 1;
  // Streak sıfırlandı mı? (önceki streak > 1 iken bu hafta break oldu)
  const streakBroken = !wasActive && oldStreak > 1;

  await pool.query(`
    UPDATE rs_users SET streak = $3, last_active_week = $4, last_active_year = $5
    WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId, newStreak, week, year]);

  return { newStreak, streakBroken, oldStreak };
}

// ── Zorunlu görev tamamla (manuel komut) ─────────────────────
async function completeMandatory(guildId, userId, username, approvedBy) {
  const { week, year } = getWeekInfo();
  await ensureUser(guildId, userId, username);
  await pool.query(`
    INSERT INTO rs_mandatory (guild_id, user_id, username, week_number, year, completed, approved_by, approved_at)
    VALUES ($1, $2, $3, $4, $5, TRUE, $6, NOW())
    ON CONFLICT (guild_id, user_id, week_number, year) DO UPDATE SET completed = TRUE, approved_by = $6, approved_at = NOW()
  `, [guildId, userId, username, week, year, approvedBy]);

  // Bug fix: 53 haftalı yılları destekler
  const user = await getUser(guildId, userId);
  const { week: prevWeek, year: prevYear } = getPrevWeekInfo();
  const wasActive = user?.last_active_week === prevWeek && user?.last_active_year === prevYear;
  const oldStreak = user?.streak ?? 0;
  const newStreak = wasActive ? oldStreak + 1 : 1;

  await pool.query(`
    UPDATE rs_users SET streak = $3, last_active_week = $4, last_active_year = $5
    WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId, newStreak, week, year]);

  return { newStreak, streakBroken: !wasActive && oldStreak > 1, oldStreak };
}

// ── Kullanıcı durumu ──────────────────────────────────────────
async function getUserStatus(guildId, userId, guild) {
  const { week, year } = getWeekInfo();
  const user = await getUser(guildId, userId);
  if (!user) return null;

  const [weekComps, mandRow, types, actRow] = await Promise.all([
    pool.query(`
      SELECT type_name, SUM(count) as count, SUM(xp_earned) as xp
      FROM rs_completions WHERE guild_id = $1 AND user_id = $2 AND week_number = $3 AND year = $4
      GROUP BY type_name
    `, [guildId, userId, week, year]),
    pool.query(`
      SELECT completed FROM rs_mandatory WHERE guild_id = $1 AND user_id = $2 AND week_number = $3 AND year = $4
    `, [guildId, userId, week, year]),
    pool.query(`
      SELECT type_name, SUM(count) as total FROM rs_completions WHERE guild_id = $1 AND user_id = $2 GROUP BY type_name
    `, [guildId, userId]),
    pool.query(`
      SELECT message_score, voice_score, task_points, mandatory_task_points, manual_points, responsibility_points
      FROM activity WHERE guild_id = $1 AND user_id = $2
    `, [guildId, userId]),
  ]);

  let roleData = null;
  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) roleData = await getRoleForUser(guildId, member);
  }

  const act = actRow.rows[0] ?? {};
  const scoreBreakdown = {
    mesaj:        parseFloat(act.message_score          ?? 0),
    ses:          parseFloat(act.voice_score            ?? 0),
    zorunlu:      parseFloat(act.mandatory_task_points  ?? 0),
    gorev:        parseFloat(act.task_points            ?? 0),
    sorumluluk:   parseFloat(act.responsibility_points  ?? 0), // Bug fix: eksikti
    manuel:       parseFloat(act.manual_points          ?? 0),
  };
  scoreBreakdown.toplam = Math.round(Object.values(scoreBreakdown).reduce((a, v) => a + v, 0) * 100) / 100;

  return {
    user,
    roleData,
    scoreBreakdown,
    weekCompletions: weekComps.rows,
    mandatoryDone: mandRow.rows[0]?.completed ?? false,
    allTimeTotals: types.rows,
    weekTotal: weekComps.rows.reduce((a, r) => a + parseInt(r.count), 0),
    weekXP: weekComps.rows.reduce((a, r) => a + parseFloat(r.xp ?? 0), 0),
  };
}

// ── Haftalık rapor ────────────────────────────────────────────
async function generateWeeklyReport(client, guildId) {
  const { week, year } = getWeekInfo();
  const { week: prevWeek, year: prevYear } = getPrevWeekInfo(); // Bug fix: 53 haftalı yıl desteği

  const logChannelId = await getCfg(guildId, 'rs_log_channel');
  if (!logChannelId) return;
  const logChannel = client.channels.cache.get(logChannelId);
  if (!logChannel) return;

  // Geçen haftanın verilerini çek
  const [comps, mands, users, actAll] = await Promise.all([
    pool.query(`
      SELECT user_id, username, SUM(count) as tasks, SUM(xp_earned) as xp
      FROM rs_completions WHERE guild_id = $1 AND week_number = $2 AND year = $3
      GROUP BY user_id, username ORDER BY xp DESC
    `, [guildId, prevWeek, prevYear]),
    pool.query(`
      SELECT user_id, username, completed FROM rs_mandatory
      WHERE guild_id = $1 AND week_number = $2 AND year = $3
    `, [guildId, prevWeek, prevYear]),
    pool.query(`SELECT * FROM rs_users WHERE guild_id = $1`, [guildId]),
    pool.query(`
      SELECT user_id,
        COALESCE(message_score,0) + COALESCE(voice_score,0) + COALESCE(task_points,0)
          + COALESCE(mandatory_task_points,0) + COALESCE(responsibility_points,0) + COALESCE(manual_points,0) AS total_xp
      FROM activity WHERE guild_id = $1
    `, [guildId]),
  ]);

  const mandMap = new Map(mands.rows.map(m => [m.user_id, m.completed]));
  const userMap = new Map(users.rows.map(u => [u.user_id, u]));
  const totalXPMap = new Map(actAll.rows.map(a => [a.user_id, parseInt(a.total_xp)]));

  const lines = comps.rows.map((r, i) => {
    const medals = ['🥇', '🥈', '🥉'];
    const medal = medals[i] ?? `**${i + 1}.**`;
    const mand = mandMap.get(r.user_id) ? '✅' : '❌';
    const streak = userMap.get(r.user_id)?.streak ?? 0;
    const streakStr = streak > 1 ? ` 🔥${streak}` : '';
    const totalXP = totalXPMap.get(r.user_id) ?? 0;
    return `${medal} **${r.username}** — ${r.tasks} görev · ${parseFloat(r.xp ?? 0).toFixed(1)} XP sorumluluk · Toplam: ${totalXP} XP · Zorunlu: ${mand}${streakStr}`;
  });

  // İnaktif kullanıcılar
  const activeIds = new Set(comps.rows.map(r => r.user_id));
  const inactiveUsers = users.rows.filter(u => !activeIds.has(u.user_id));

  const embed = new EmbedBuilder()
    .setColor(0x9966ff)
    .setTitle(`📊 Haftalık Performans Raporu — Hafta ${prevWeek}/${prevYear}`)
    .setDescription(lines.length ? lines.join('\n') : '*Bu hafta hiç kayıt yok.*')
    .setTimestamp();

  if (inactiveUsers.length) {
    embed.addFields({
      name: '😴 İnaktif Kullanıcılar',
      value: inactiveUsers.map(u => `• **${u.username}**`).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  await logChannel.send({ embeds: [embed] });
}

// ── Yetki sistemi panel raporu ────────────────────────────────
async function generateSystemPanel(client, guildId, guild) {
  const { week, year } = getWeekInfo();

  // Tüm verileri paralel çek
  const [roles, rsUsers, actAll, mandAll, weekTasks] = await Promise.all([
    getRoles(guildId),
    // Bug fix: current_xp hiçbir zaman güncellenmez, JS tarafında activity tablosuna göre sıralanır
    pool.query(`SELECT * FROM rs_users WHERE guild_id = $1`, [guildId]),
    pool.query(`
      SELECT user_id,
        COALESCE(message_score,0) + COALESCE(voice_score,0) + COALESCE(task_points,0)
          + COALESCE(mandatory_task_points,0) + COALESCE(responsibility_points,0) + COALESCE(manual_points,0) AS total_xp
      FROM activity WHERE guild_id = $1
    `, [guildId]),
    pool.query(`
      SELECT user_id, completed FROM rs_mandatory
      WHERE guild_id = $1 AND week_number = $2 AND year = $3
    `, [guildId, week, year]),
    pool.query(`
      SELECT user_id, COUNT(*) as count FROM task_assignments ta
      JOIN tasks t ON t.id = ta.task_id
      WHERE t.guild_id = $1 AND ta.status = 'tamamlandı'
        AND ta.completed_at >= $2
      GROUP BY user_id
    `, [guildId, getWeekStart()]),
  ]);

  const xpMap   = new Map(actAll.rows.map(a => [a.user_id, parseInt(a.total_xp ?? 0)]));
  const mandMap = new Map(mandAll.rows.map(m => [m.user_id, m.completed]));
  const weekMap = new Map(weekTasks.rows.map(w => [w.user_id, parseInt(w.count)]));

  // ── Embed 1: Rol Hiyerarşisi ────────────────────────────────
  const hierLines = roles.length
    ? roles.map(r =>
        `**${r.position}.** <@&${r.role_id}>\n` +
        `┣ 🏆 Gereken XP: **${r.xp_required}**\n` +
        `┣ 📋 Haftalık Görev: **${r.weekly_tasks_required}** / ${r.task_period_weeks} hafta\n` +
        `┣ 🔢 Görev Limiti: **${r.responsibility_limit}** görev/hafta\n` +
        `┗ ✖️ XP Çarpanı: **${r.xp_multiplier}x**`
      ).join('\n\n')
    : '*Henüz rol eklenmemiş. `/staff role-add` ile ekle.*';

  const hierEmbed = new EmbedBuilder()
    .setColor(0x9966ff)
    .setTitle('🎭 Yetki Sistemi — Rol Hiyerarşisi')
    .setDescription(hierLines)
    .setFooter({ text: `Hafta ${week}/${year}` })
    .setTimestamp();

  // ── Embed 2: Kullanıcı Durumları ────────────────────────────
  const medals = ['🥇', '🥈', '🥉'];
  const userLines = [];

  // XP'ye göre sırala (activity tablosundan gelen gerçek değer)
  const sorted = [...rsUsers.rows].sort((a, b) => (xpMap.get(b.user_id) ?? 0) - (xpMap.get(a.user_id) ?? 0));

  // Bug fix: N+1 — guild üyelerini bir kez toplu çek, döngüde tekrar tekrar sorgulatma
  // Bug fix: rol araması getRoleForUser → DB sorgusu yerine zaten çekilen 'roles' dizisini kullan
  const allMembersMap = guild ? await guild.members.fetch().catch(() => new Map()) : new Map();
  const findRoleForMember = (member) => {
    for (const r of [...roles].reverse()) {
      if (member.roles.cache.has(r.role_id)) return r;
    }
    return null;
  };

  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i];
    const totalXP   = xpMap.get(u.user_id) ?? 0;
    const mandDone  = mandMap.get(u.user_id) ?? false;
    const weekDone  = weekMap.get(u.user_id) ?? 0;
    const streak    = u.streak ?? 0;

    let currentRole = null;
    let nextRole    = null;
    const member = allMembersMap.get(u.user_id);
    if (member) {
      currentRole = findRoleForMember(member);
      if (currentRole) nextRole = roles.find(r => r.position === currentRole.position + 1) ?? null;
    }

    const medal      = medals[i] ?? `**${i + 1}.**`;
    const roleStr    = currentRole ? `<@&${currentRole.role_id}>` : '*Rol yok*';
    const streakStr  = streak > 1 ? ` 🔥 ${streak}hf` : '';
    const mandStr    = mandDone ? '✅' : '❌';
    const weekLimit  = currentRole?.responsibility_limit ?? '?';

    let nextStr = '';
    if (nextRole) {
      const xpNeeded = nextRole.xp_required - totalXP;
      nextStr = xpNeeded > 0
        ? ` → **${nextRole.role_name}** için **${xpNeeded} XP** kaldı`
        : ` → **${nextRole.role_name}** için hazır! 🎉`;
    }

    userLines.push(
      `${medal} <@${u.user_id}> — ${roleStr} · **${totalXP} XP**${streakStr}\n` +
      `┣ Bu hafta: **${weekDone}/${weekLimit}** görev · Zorunlu: ${mandStr}` +
      (nextStr ? `\n┗${nextStr}` : '')
    );
  }

  const userEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('👥 Yetki Sistemi — Kullanıcı Durumları')
    .setDescription(userLines.length ? userLines.join('\n\n') : '*Henüz kayıtlı kullanıcı yok.*')
    .setFooter({ text: `Bu hafta zorunlu tamamlayan: ${mandAll.rows.filter(m => m.completed).length}/${rsUsers.rows.length}` })
    .setTimestamp();

  return [hierEmbed, userEmbed];
}

// ── İnaktivite kontrolü ───────────────────────────────────────
async function checkInactivity(client) {
  const { week, year } = getWeekInfo();
  const { week: prevWeek, year: prevYear } = getPrevWeekInfo(); // Bug fix: 53 haftalı yıl desteği

  // Her guild için kontrol
  const guildsRes = await pool.query(`SELECT DISTINCT guild_id FROM rs_users`);
  for (const { guild_id } of guildsRes.rows) {
    const logChannelId = await getCfg(guild_id, 'rs_log_channel');
    if (!logChannelId) continue;
    const logChannel = client.channels.cache.get(logChannelId);
    if (!logChannel) continue;

    // Geçen hafta hiç görev yapmayan kullanıcılar
    // Sorumluluk tamamlayanlar + zorunlu görev tamamlayanlar aktif sayılır
    const activeRes = await pool.query(`
      SELECT DISTINCT user_id FROM rs_completions
      WHERE guild_id = $1 AND week_number = $2 AND year = $3
      UNION
      SELECT DISTINCT user_id FROM rs_mandatory
      WHERE guild_id = $1 AND week_number = $2 AND year = $3 AND completed = TRUE
    `, [guild_id, prevWeek, prevYear]);
    const activeIds = new Set(activeRes.rows.map(r => r.user_id));

    const allUsers = await pool.query(`SELECT * FROM rs_users WHERE guild_id = $1`, [guild_id]);

    for (const user of allUsers.rows) {
      if (activeIds.has(user.user_id)) continue;

      const newWarningCount = (user.warning_count ?? 0) + 1;

      await pool.query(`
        UPDATE rs_users SET warning_count = $3, last_warned_at = NOW()
        WHERE guild_id = $1 AND user_id = $2
      `, [guild_id, user.user_id, newWarningCount]);

      await pool.query(`
        INSERT INTO rs_warnings (guild_id, user_id, username, week_number, year, warning_number, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [guild_id, user.user_id, user.username, prevWeek, prevYear, newWarningCount, 'Haftalık görev yapılmadı']);

      const embed = new EmbedBuilder()
        .setColor(0xff9900)
        .setTitle(`⚠️ İnaktivite Uyarısı #${newWarningCount}`)
        .setDescription(`**${user.username}** geçen hafta hiç görev tamamlamadı.`)
        .addFields(
          { name: '👤 Kullanıcı',    value: `<@${user.user_id}>`,        inline: true },
          { name: '⚠️ Uyarı Sayısı', value: `${newWarningCount}`,         inline: true },
          { name: '📅 Hafta',        value: `${prevWeek}/${prevYear}`,    inline: true },
        )
        .setTimestamp();

      await logChannel.send({ embeds: [embed] }).catch(() => {});

      // DM devre dışı
    }
  }
}

// ── Manuel uyarı ──────────────────────────────────────────────
async function warnUser(guildId, userId, username, reason) {
  const { week, year } = getWeekInfo();
  await ensureUser(guildId, userId, username);

  const user = await getUser(guildId, userId);
  const newCount = (user?.warning_count ?? 0) + 1;

  await pool.query(`
    UPDATE rs_users SET warning_count = $3, last_warned_at = NOW()
    WHERE guild_id = $1 AND user_id = $2
  `, [guildId, userId, newCount]);

  await pool.query(`
    INSERT INTO rs_warnings (guild_id, user_id, username, week_number, year, warning_number, reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [guildId, userId, username, week, year, newCount, reason]);

  return newCount;
}

module.exports = {
  getWeekInfo, getCfg, setCfg,
  addRole, removeRole, getRoles, getRoleForUser,
  addType, removeType, getTypes, getType,
  ensureUser, getUser,
  calcTaskXP, checkPromotion,
  completeMandatoryFromTask, completeResponsibility, completeMandatory,
  getUserStatus,
  generateWeeklyReport, generateSystemPanel, checkInactivity,
  warnUser,
};

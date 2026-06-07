const { pool } = require('./database');
const { PermissionFlagsBits } = require('discord.js');
const { isStaff } = require('./staffRoles');

// Her zaman her şeyi kullanabilen kullanıcılar (bot sahibi vb.)
const SUPER_USERS = (process.env.BOT_SUPER_USERS ?? process.env.BOT_ALLOWED_USERS ?? '')
  .split(',').map(id => id.trim()).filter(Boolean);

// Asla devredilemeyen komutlar — sadece Administrator
const ADMIN_ONLY = ['guard', 'listenroles'];

// ── Kullanıcı için komut izni kontrol et ──────────────────────
async function checkPermission(interaction) {
  const cmdName = interaction.commandName;
  const sub     = interaction.options?.getSubcommand?.(false);
  const userId  = interaction.user.id;
  const member  = interaction.member;

  // 1. Super user → her zaman izinli
  if (SUPER_USERS.includes(userId)) return true;

  // 2. Sunucu sahibi → her zaman izinli
  if (interaction.guild.ownerId === userId) return true;

  // 3. ADMIN_ONLY komutları sadece Administrator'a açık
  if (ADMIN_ONLY.includes(cmdName)) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }

  // 4. Genel (kısıtlanmamış) komutlar → herkese açık
  const cmd = interaction.client.commands.get(cmdName);
  if (cmd?.category === 'genel') return true;

  // 5. Yetkili (staff) üye → yönetici komutlarını kullanabilir
  const staffCheck = await isStaff(member).catch(() => false);
  if (staffCheck) return true;

  // 6. DB'de bu komuta özel ek rol grant'ı var mı? (daha granüler kontrol)
  const guildId = interaction.guild.id;
  const checkKeys = sub ? [`${cmdName}:${sub}`, cmdName] : [cmdName];

  for (const key of checkKeys) {
    const res = await pool.query(
      `SELECT role_id FROM command_permissions WHERE guild_id = $1 AND command_name = $2`,
      [guildId, key]
    );
    if (!res.rows.length) continue;

    const grantedRoles = res.rows.map(r => r.role_id);
    const memberRoles  = member.roles.cache.map(r => r.id);
    if (grantedRoles.some(r => memberRoles.includes(r))) return true;
  }

  return false;
}

// ── Rol ekle ──────────────────────────────────────────────────
async function grantRole(guildId, commandName, roleId) {
  await pool.query(
    `INSERT INTO command_permissions (guild_id, command_name, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [guildId, commandName, roleId]
  );
}

// ── Rol kaldır ────────────────────────────────────────────────
async function revokeRole(guildId, commandName, roleId) {
  const res = await pool.query(
    `DELETE FROM command_permissions WHERE guild_id = $1 AND command_name = $2 AND role_id = $3`,
    [guildId, commandName, roleId]
  );
  return res.rowCount > 0;
}

// ── Komutun grant listesini al ────────────────────────────────
async function getGrants(guildId, commandName = null) {
  if (commandName) {
    const res = await pool.query(
      `SELECT role_id FROM command_permissions WHERE guild_id = $1 AND command_name = $2 ORDER BY role_id`,
      [guildId, commandName]
    );
    return res.rows.map(r => r.role_id);
  }
  const res = await pool.query(
    `SELECT command_name, role_id FROM command_permissions WHERE guild_id = $1 ORDER BY command_name`,
    [guildId]
  );
  // { commandName: [roleId, ...] }
  const map = {};
  for (const row of res.rows) {
    if (!map[row.command_name]) map[row.command_name] = [];
    map[row.command_name].push(row.role_id);
  }
  return map;
}

// ── Komut için tüm grantları sil ─────────────────────────────
async function resetGrants(guildId, commandName) {
  const res = await pool.query(
    `DELETE FROM command_permissions WHERE guild_id = $1 AND command_name = $2`,
    [guildId, commandName]
  );
  return res.rowCount;
}

module.exports = { checkPermission, grantRole, revokeRole, getGrants, resetGrants, ADMIN_ONLY };

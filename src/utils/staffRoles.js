const { pool } = require('./database');

const TTL = 60_000;
const cache = new Map(); // guildId → { roles: Set<roleId>, lastLoaded: number }

async function loadFromDB(guildId) {
  const res = await pool.query(`SELECT role_id FROM staff_roles WHERE guild_id = $1`, [guildId]);
  cache.set(guildId, { roles: new Set(res.rows.map(r => r.role_id)), lastLoaded: Date.now() });
}

async function isStaff(member) {
  const guildId = member.guild.id;
  const entry = cache.get(guildId);
  if (!entry || Date.now() - entry.lastLoaded > TTL) await loadFromDB(guildId);
  return member.roles.cache.some(r => cache.get(guildId)?.roles.has(r.id));
}

async function addRole(guildId, roleId, roleName, addedBy) {
  await pool.query(
    `INSERT INTO staff_roles (guild_id, role_id, role_name, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, role_id) DO UPDATE SET role_name = $3`,
    [guildId, roleId, roleName, addedBy]
  );
  const entry = cache.get(guildId);
  if (entry) entry.roles.add(roleId);
}

async function removeRole(guildId, roleId) {
  await pool.query(`DELETE FROM staff_roles WHERE guild_id = $1 AND role_id = $2`, [guildId, roleId]);
  cache.get(guildId)?.roles.delete(roleId);
}

async function getRoles(guildId) {
  const res = await pool.query(`SELECT * FROM staff_roles WHERE guild_id = $1 ORDER BY added_at DESC`, [guildId]);
  return res.rows;
}

module.exports = { isStaff, addRole, removeRole, getRoles, loadFromDB };

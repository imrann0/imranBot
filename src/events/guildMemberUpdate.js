const { pool } = require('../utils/database');

module.exports = {
  name: 'guildMemberUpdate',
  async execute(oldMember, newMember) {
    const guildId = newMember.guild.id;

    // Yeni eklenen rolleri bul
    const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
    if (!addedRoles.size) return;

    const addedRoleIds = [...addedRoles.keys()];

    // Bu role atanmış aktif tekrarlayan görevleri bul
    const tasks = await pool.query(`
      SELECT id, assigned_role_ids
      FROM tasks
      WHERE guild_id = $1
        AND status IN ('bekliyor', 'devam')
        AND recurrence IS NOT NULL
    `, [guildId]);

    for (const task of tasks.rows) {
      const taskRoleIds = (task.assigned_role_ids ?? []).map(r => r.id ?? r);
      const hasRole = addedRoleIds.some(id => taskRoleIds.includes(id));
      if (!hasRole) continue;

      // Kullanıcıya zaten atanmış mı?
      const exists = await pool.query(
        `SELECT 1 FROM task_assignments WHERE task_id = $1 AND user_id = $2`,
        [task.id, newMember.id]
      );
      if (exists.rows.length) continue;

      // Görevi ata
      await pool.query(
        `INSERT INTO task_assignments (task_id, user_id, username, assigned_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [task.id, newMember.id, newMember.user.username]
      );

      console.log(`[GuildMemberUpdate] #${task.id} görevi → ${newMember.user.username} (yeni rol: ${addedRoleIds.join(', ')})`);
    }
  },
};

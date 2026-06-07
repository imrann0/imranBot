const { AuditLogEvent } = require('discord.js');
const { logMod } = require('../utils/activityTracker');

const ACTION_MAP = {
  [AuditLogEvent.MemberKick]:             'Kick',
  [AuditLogEvent.MemberBanAdd]:           'Ban',
  [AuditLogEvent.MemberBanRemove]:        'Unban',
  [AuditLogEvent.MemberUpdate]:           'Timeout',
  [AuditLogEvent.MemberRoleUpdate]:       'Rol Değişimi',
  [AuditLogEvent.MessageDelete]:          'Mesaj Silindi',
  [AuditLogEvent.ChannelOverwriteCreate]: 'Kanal İzni Değişti',
};

module.exports = {
  name: 'guildAuditLogEntryCreate',
  async execute(auditLog, guild) {
    const actionType = ACTION_MAP[auditLog.action];
    if (!actionType) return;

    const guildId  = guild?.id ?? auditLog.guild?.id;
    if (!guildId) return;

    const target   = auditLog.target;
    const executor = auditLog.executor;

    // Timeout kontrolü: MemberUpdate ama timeout değilse geç
    if (auditLog.action === AuditLogEvent.MemberUpdate) {
      const hasCommunicationDisabled = auditLog.changes?.some(c => c.key === 'communication_disabled_until');
      if (!hasCommunicationDisabled) return;
    }

    let durationSeconds = null;
    if (auditLog.action === AuditLogEvent.MemberUpdate) {
      const change = auditLog.changes?.find(c => c.key === 'communication_disabled_until');
      if (change?.new) {
        durationSeconds = Math.floor((new Date(change.new) - Date.now()) / 1000);
      }
    }

    await logMod({
      guildId,
      actionType,
      targetUserId:     target?.id       ?? 'bilinmiyor',
      targetUsername:   target?.username ?? target?.tag ?? 'bilinmiyor',
      executorUserId:   executor?.id     ?? null,
      executorUsername: executor?.username ?? null,
      reason:           auditLog.reason  ?? null,
      durationSeconds,
    });

    console.log(`⚖️ ${actionType} | ${target?.username} tarafından ${executor?.username}`);
  },
};

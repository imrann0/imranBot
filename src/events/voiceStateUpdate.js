const { voiceJoin, voiceLeave, voiceMicOn, voiceMicOff } = require('../utils/activityTracker');
const { isStaff } = require('../utils/staffRoles');

// Kullanıcı kanalda mı? (serverMute/serverDeaf channel presence'ı bozmaz)
function isActiveChannel(state) {
  if (!state.channelId) return false;
  if (state.channelId === state.guild.afkChannelId) return false;
  return true;
}

// Mikrofon gerçekten açık mı? (serverMute da engelliyor)
function isMicOn(state) {
  return !state.selfMute && !state.selfDeaf && !state.serverMute && !state.serverDeaf;
}

module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState) {
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;
    if (!await isStaff(member)) return;

    const guildId = member.guild.id;
    const wasInChannel = isActiveChannel(oldState);
    const nowInChannel = isActiveChannel(newState);
    const changedChannel = wasInChannel && nowInChannel && oldState.channelId !== newState.channelId;

    // ── Kanal değişikliği ──────────────────────────────────────
    if (changedChannel) {
      await voiceLeave(guildId, member.id);
      const channelName = newState.channel?.name ?? 'bilinmiyor';
      await voiceJoin(guildId, member.id, member.user.username, newState.channelId, channelName, isMicOn(newState));
      console.log(`🔄 ${member.user.username} kanal değiştirdi → #${channelName}`);
      return;
    }

    // ── Kanala giriş / çıkış ───────────────────────────────────
    if (!wasInChannel && nowInChannel) {
      const channelName = newState.channel?.name ?? 'bilinmiyor';
      await voiceJoin(guildId, member.id, member.user.username, newState.channelId, channelName, isMicOn(newState));
      console.log(`🎙️ ${member.user.username} → #${channelName} (mic: ${isMicOn(newState) ? 'açık' : 'kapalı'})`);
      return;
    }

    if (wasInChannel && !nowInChannel) {
      await voiceLeave(guildId, member.id);
      const reason = !newState.channelId ? 'kanaldan çıktı'
        : newState.channelId === newState.guild.afkChannelId ? 'AFK kanalına geçti'
        : 'sunucu tarafından susturuldu';
      console.log(`🔇 ${member.user.username} pasif (${reason})`);
      return;
    }

    // ── Aynı kanalda mic/deaf değişimi ────────────────────────
    if (wasInChannel && nowInChannel) {
      const wasMicOn = isMicOn(oldState);
      const nowMicOn = isMicOn(newState);

      if (!wasMicOn && nowMicOn) {
        await voiceMicOn(guildId, member.id);
        console.log(`🟢 ${member.user.username} mikrofon açtı`);
      } else if (wasMicOn && !nowMicOn) {
        await voiceMicOff(guildId, member.id);
        const reason = (newState.selfDeaf || newState.serverDeaf) ? 'kulaklık kapattı' : 'mikrofon kapattı';
        console.log(`🔴 ${member.user.username} ${reason}`);
      }
    }
  },
};

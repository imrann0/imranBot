const { ActivityType } = require('discord.js');
const { voiceJoin, voiceLeave, init } = require('../utils/activityTracker');
const { pool } = require('../utils/database');
const { isStaff, loadFromDB, addRole } = require('../utils/staffRoles');
const { checkRecurringTasks, checkDeadlines } = require('../utils/taskManager');
const { generateWeeklyReport, checkInactivity } = require('../utils/roleSystem');

const activities = [
  { name: 'Sekai', type: ActivityType.Watching },
];

module.exports = {
  name: 'ready',
  once: true,
  async execute(client) {
    await init();

    // .env'deki rolleri ilk açılışta her guild için DB'ye aktar
    const envRoles = (process.env.STAFF_ROLE_IDS ?? '').split(',').map(r => r.trim()).filter(Boolean);
    for (const guild of client.guilds.cache.values()) {
      for (const roleId of envRoles) {
        await addRole(guild.id, roleId, roleId, 'sistem').catch(() => {});
      }
      // Her guild için staffRoles cache'ini yükle
      await loadFromDB(guild.id);
    }

    console.log(`✅ ${client.user.tag} olarak giriş yapıldı!`);
    console.log(`📡 Kayıtlı sunucular (${client.guilds.cache.size}):`);
    client.guilds.cache.forEach(g => console.log(`   • ${g.name} (${g.id}) — ${g.memberCount} üye`));

    // Tekrarlayan görev kontrolü — her saat başı
    await checkRecurringTasks(client).catch(e => console.error('[RecurringTasks boot]', e.message));
    setInterval(() => checkRecurringTasks(client).catch(e => console.error('[RecurringTasks]', e.message)), 60 * 60 * 1000).unref();

    // Deadline hatırlatıcısı — her 6 saatte bir kontrol
    await checkDeadlines(client).catch(e => console.error('[Deadlines boot]', e.message));
    setInterval(() => checkDeadlines(client).catch(e => console.error('[Deadlines]', e.message)), 6 * 60 * 60 * 1000).unref();

    // Haftalık rapor & inaktivite kontrolü — her gün Pazartesi 09:00'da
    let lastWeeklyCheck = null;
    setInterval(() => (async () => {
      const now = new Date();
      const isMonday = now.getDay() === 1;
      const dateKey  = now.toISOString().slice(0, 10);
      if (!isMonday || lastWeeklyCheck === dateKey) return;
      lastWeeklyCheck = dateKey;
      console.log('[YetkiSistemi] Haftalık rapor & inaktivite kontrolü başlıyor...');
      for (const guild of client.guilds.cache.values()) {
        await generateWeeklyReport(client, guild.id).catch(e => console.error('[Rapor]', e.message));
      }
      await checkInactivity(client).catch(e => console.error('[İnaktivite]', e.message));
    })().catch(e => console.error('[HaftalıkKontrol]', e.message)), 60 * 60 * 1000); // Her saat kontrol et

    client.user.setPresence({
      activities: [activities[0]],
      status: 'online',
    });

    // Bot açılınca seste olan yetkilileri kaydet
    for (const guild of client.guilds.cache.values()) {
      // 1. Açık kalan eski oturumları kapat (bot kapalıyken kanaldan çıkmış kullanıcılar)
      // NOT: voiceLeave() ÇAĞRILMAZ — bot kapalıyken ne zaman çıktığını bilmiyoruz,
      // yanlış (41 saat gibi) süreler voice_logs'a yazılmasın.
      const openSessions = await pool.query(
        `SELECT user_id FROM activity WHERE guild_id = $1 AND voice_joined_at IS NOT NULL`,
        [guild.id]
      );
      const phantomIds = [];
      for (const row of openSessions.rows) {
        const voiceState = guild.voiceStates.cache.get(row.user_id);
        const stillInVoice = voiceState?.channelId && voiceState.channelId !== guild.afkChannelId;
        if (!stillInVoice) phantomIds.push(row.user_id);
      }
      if (phantomIds.length > 0) {
        // Süresi bilinmeyen oturumları log yazmadan temizle
        await pool.query(
          `UPDATE activity
           SET voice_joined_at = NULL, voice_mic_on_at = NULL, voice_active_seconds = 0,
               voice_channel_id = NULL, voice_channel_name = NULL
           WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
          [guild.id, phantomIds]
        );
        console.log(`🔧 ${phantomIds.length} phantom session temizlendi (log yazılmadı):`, phantomIds);
      }

      // 2. Şu an seste olan yetkilileri yeniden kaydet
      for (const [, state] of guild.voiceStates.cache) {
        if (!state.channelId || !state.member) continue;
        if (!await isStaff(state.member)) continue;
        if (state.channelId === guild.afkChannelId) continue;
        const channelName = state.channel?.name ?? 'bilinmiyor';
        const micOn = !state.selfMute && !state.selfDeaf && !state.serverMute && !state.serverDeaf;
        await voiceJoin(guild.id, state.member.id, state.member.user.username, state.channelId, channelName, micOn);
        console.log(`🎙️ ${state.member.user.username} zaten seste → #${channelName} (mic: ${micOn ? 'açık' : 'kapalı'})`);
      }
    }
  },
};

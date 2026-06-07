const {
  SlashCommandBuilder, EmbedBuilder, MessageFlags,
} = require('discord.js');
const { pool } = require('../../utils/database');

async function getCfg(guildId, key) {
  const res = await pool.query(
    `SELECT value FROM guild_config WHERE guild_id = $1 AND key = $2`,
    [guildId, key]
  );
  return res.rows[0]?.value ?? null;
}

function uptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}g ${h % 24}s ${m % 60}dk`;
  if (h > 0) return `${h}s ${m % 60}dk`;
  return `${m}dk ${s % 60}sn`;
}

function memUsage() {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  return `${used.toFixed(1)} MB`;
}

// Komutlar ve açıklamaları
const COMMAND_LIST = {
  '⚙️ Yönetici': [
    { cmd: '/task setup',           desc: 'Görev panelini ve kanalları kur' },
    { cmd: '/task list',            desc: 'Görevleri filtrele ve listele' },
    { cmd: '/task edit',            desc: 'Görevi düzenle' },
    { cmd: '/task complete',        desc: 'Admin olarak görevi tamamla' },
    { cmd: '/task templates',       desc: 'Kayıtlı şablonları yönet' },
    { cmd: '/task kategori-ekle',   desc: 'Görev kategorisi ekle' },
    { cmd: '/task kategori-kaldir', desc: 'Görev kategorisini kaldır' },
    { cmd: '/task kategoriler',     desc: 'Görev kategorilerini listele' },
    { cmd: '/staff setup',          desc: 'Yetkili sistemi log kanalını ayarla' },
    { cmd: '/staff role-add',       desc: 'Sisteme rol ekle' },
    { cmd: '/staff role-remove',    desc: 'Sistemden rol kaldır' },
    { cmd: '/staff roles',          desc: 'Tüm yetkili rollerini listele' },
    { cmd: '/staff status',         desc: 'Kullanıcının yetkili durumunu göster' },
    { cmd: '/staff report',         desc: 'Haftalık raporu manuel gönder' },
    { cmd: '/staff panel',          desc: 'Yetkili genel bakış panelini gönder' },
    { cmd: '/staff warn',           desc: 'Kullanıcıyı manuel uyar' },
    { cmd: '/staff promotions',     desc: 'Terfi taleplerini listele' },
    { cmd: '/season baslat',        desc: 'Yeni sezon başlat' },
    { cmd: '/season bitir',         desc: 'Sezonu kapat — arşivle ve sıfırla' },
    { cmd: '/season bilgi',         desc: 'Aktif sezon bilgisi' },
    { cmd: '/season gecmis',        desc: 'Tüm geçmiş sezonları listele' },
    { cmd: '/season arsiv',         desc: 'Geçmiş sezonun sıralamasını göster' },
    { cmd: '/points add',           desc: 'Kullanıcıya manuel puan ekle/çıkar' },
    { cmd: '/points history',       desc: 'Manuel puan geçmişini göster' },
    { cmd: '/permissions ver',      desc: 'Bir role komut erişimi ver' },
    { cmd: '/permissions al',       desc: 'Bir rolden komut erişimini kaldır' },
    { cmd: '/permissions liste',    desc: 'Komut izin listesini göster' },
    { cmd: '/permissions herkes',   desc: 'Tüm komut erişim tablosunu göster' },
    { cmd: '/guard vanity',         desc: 'Vanity URL koruması kur' },
    { cmd: '/guard rol-koruma',     desc: 'Yönetici yetkisi veren kişiyi otomatik banla' },
    { cmd: '/guard rol-koruma-kapat', desc: 'Rol koruma sistemini kapat' },
    { cmd: '/guard durum',          desc: 'Guard sistemi durumunu göster' },
    { cmd: '/guard kapat',          desc: 'Guard sistemini kapat' },
    { cmd: '/confession setup',     desc: 'Anonim itiraf panelini kur' },
    { cmd: '/confession ac',        desc: 'İtiraf sistemini aç' },
    { cmd: '/confession kapat',     desc: 'İtiraf sistemini kapat' },
    { cmd: '/score',                desc: 'XP puan sistemi ayarları' },
    { cmd: '/listenroles',          desc: 'Takip edilen yetkili rollerini yönet' },
    { cmd: '/logchannel',           desc: 'Mesaj loglama kanalı engelle/kaldır' },
    { cmd: '/modlog',               desc: 'Mod log kayıtlarını göster' },
    { cmd: '/report',               desc: 'Aktivite raporu — kişi veya sunucu geneli' },
    { cmd: '/voice',                desc: 'Kullanıcı ses oturumlarını göster' },
    { cmd: '/messages',             desc: 'Kullanıcı mesaj loglarını göster' },
    { cmd: '/activity',             desc: 'Yetkili aktivite raporunu göster' },
    { cmd: '/partnership setup',    desc: 'Partnerlik kanalını tanımla' },
    { cmd: '/partnership liste',    desc: 'Kişinin partnerlik geçmişini göster' },
    { cmd: '/partnership tümü',     desc: 'Tüm partnerlik sıralaması' },
  ],
  '🌐 Genel': [
    { cmd: '/profil',       desc: 'XP, streak ve görev istatistiklerini göster' },
    { cmd: '/my-tasks',     desc: 'Sana atanan görevleri listele' },
    { cmd: '/leaderboard',  desc: 'Skor, ses, mesaj, görev veya streak sıralaması' },
    { cmd: '/botinfo',      desc: 'Bot bilgisi ve komut listesi' },
    { cmd: '/ping',         desc: 'Bot gecikme süresi' },
  ],
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('Bot hakkında tüm bilgileri ve komutları gösterir'),
  category: 'genel',

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const client   = interaction.client;
    const guildId  = interaction.guild.id;

    // ── Sistem bilgileri ──────────────────────────────────────
    const uptimeStr   = uptime(client.uptime);
    const memStr      = memUsage();
    const ping        = client.ws.ping;
    const totalGuilds = client.guilds.cache.size;
    const totalUsers  = client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);

    // ── Bu sunucunun ayarları ─────────────────────────────────
    const [
      taskPanel, taskCh, pointsLog, guardVanity, guardLog,
      roleGuard, roleGuardLog, itirafCh, itirafPanel,
    ] = await Promise.all([
      getCfg(guildId, 'task_panel_channel'),
      getCfg(guildId, 'task_tasks_channel'),
      getCfg(guildId, 'points_log_channel'),
      getCfg(guildId, 'guard_vanity_code'),
      getCfg(guildId, 'guard_log_channel'),
      getCfg(guildId, 'guard_role_enabled'),
      getCfg(guildId, 'guard_role_log_channel'),
      getCfg(guildId, 'itiraf_channel'),
      getCfg(guildId, 'itiraf_panel_channel'),
    ]);

    // ── DB istatistikleri ─────────────────────────────────────
    const [actRes, taskRes, modRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM activity WHERE guild_id = $1`, [guildId]),
      pool.query(`SELECT COUNT(*) FROM tasks WHERE guild_id = $1`, [guildId]),
      pool.query(`SELECT COUNT(*) FROM mod_logs WHERE guild_id = $1`, [guildId]),
    ]);

    const ch = (id)  => id  ? `<#${id}>` : '❌ Kapalı';
    const on = (val) => val ? '✅ Aktif'  : '❌ Kapalı';

    // ── Embed 1: Sistem + Ayarlar ─────────────────────────────
    const infoEmbed = new EmbedBuilder()
      .setColor(0x9966ff)
      .setTitle(`🤖 ${client.user.username} — Bot Bilgisi`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        {
          name: '⚙️ Sistem',
          value: [
            `**Uptime:** ${uptimeStr}`,
            `**Ping:** ${ping}ms`,
            `**RAM:** ${memStr}`,
            `**Sunucular:** ${totalGuilds} sunucu`,
            `**Toplam Üye:** ${totalUsers.toLocaleString()}`,
          ].join('\n'),
          inline: true,
        },
        {
          name: '📊 Bu Sunucu',
          value: [
            `**Takip Edilen:** ${actRes.rows[0].count} üye`,
            `**Toplam Görev:** ${taskRes.rows[0].count}`,
            `**Mod Log:** ${modRes.rows[0].count} kayıt`,
          ].join('\n'),
          inline: true,
        },
        { name: '​', value: '​', inline: false },
        {
          name: '📋 Görev Sistemi',
          value: `**Panel:** ${ch(taskPanel)}\n**Görev Kanalı:** ${ch(taskCh)}`,
          inline: true,
        },
        {
          name: '⭐ Puan & 💌 İtiraf',
          value: [
            `**Puan Log:** ${ch(pointsLog)}`,
            `**İtiraf:** ${on(itirafCh)}`,
            `**İtiraf Kanalı:** ${ch(itirafCh)}`,
          ].join('\n'),
          inline: true,
        },
        {
          name: '🛡️ Guard',
          value: [
            `**Vanity:** ${guardVanity ? `✅ discord.gg/${guardVanity}` : '❌ Kapalı'}`,
            `**Vanity Log:** ${ch(guardLog)}`,
            `**Rol Koruma:** ${on(roleGuard === 'true')}`,
            `**Rol Log:** ${ch(roleGuardLog)}`,
          ].join('\n'),
          inline: true,
        },
      )
      .setFooter({ text: 'SekaiBot', iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    // ── Embed 2: Komut Listesi ────────────────────────────────
    const cmdEmbed = new EmbedBuilder()
      .setColor(0x9966ff)
      .setTitle('📖 Komut Listesi');

    for (const [category, commands] of Object.entries(COMMAND_LIST)) {
      cmdEmbed.addFields({
        name: category,
        value: commands.map(c => `\`${c.cmd}\` — ${c.desc}`).join('\n'),
        inline: false,
      });
    }

    return interaction.editReply({ embeds: [infoEmbed, cmdEmbed] });
  },
};

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { grantRole, revokeRole, getGrants, resetGrants, ADMIN_ONLY } = require('../../utils/commandPermissions');

// Mevcut yönetici komutları ve açıklamaları
const COMMAND_LIST = [
  { name: 'staff',                   desc: 'Yetkili sıralama sistemi (tüm alt komutlar)' },
  { name: 'staff:status',            desc: 'Kullanıcının yetkili durumunu göster' },
  { name: 'staff:roles',             desc: 'Tüm yetkili rollerini listele' },
  { name: 'staff:panel',             desc: 'Yetkili sistemi panelini gönder' },
  { name: 'staff:promotions',        desc: 'Terfi taleplerini listele' },
  { name: 'task',                    desc: 'Görev sistemi yönetimi (tüm alt komutlar)' },
  { name: 'task:list',               desc: 'Görevleri listele' },
  { name: 'task:complete',           desc: 'Admin olarak görevi tamamla' },
  { name: 'season',                  desc: 'Sezon sistemi (tüm alt komutlar)' },
  { name: 'season:bilgi',            desc: 'Aktif sezon bilgisi' },
  { name: 'season:gecmis',           desc: 'Geçmiş sezonları listele' },
  { name: 'season:arsiv',            desc: 'Geçmiş sezon sıralaması' },
  { name: 'leaderboard',             desc: 'XP sıralaması' },
  { name: 'activity',                desc: 'Aktivite raporu' },
  { name: 'report',                  desc: 'Aktivite özeti' },
  { name: 'partnership',             desc: 'Partnerlik sistemi (tüm alt komutlar)' },
  { name: 'partnership:liste',       desc: 'Partnerlik geçmişini görüntüle' },
  { name: 'partnership:tümü',        desc: 'Tüm partnerlik sıralaması' },
  { name: 'points',                  desc: 'Manuel puan işlemleri' },
  { name: 'confession',              desc: 'İtiraf sistemi yönetimi' },
  { name: 'confession:setup',        desc: 'İtiraf panelini kur' },
  { name: 'confession:ac',           desc: 'İtiraf sistemini aç' },
  { name: 'confession:kapat',        desc: 'İtiraf sistemini kapat' },
  { name: 'modlog',                  desc: 'Mod log yönetimi' },
  { name: 'score',                   desc: 'Puan sistemi ayarları' },
  { name: 'logchannel',              desc: 'Log kanal yönetimi' },
  { name: 'messages',                desc: 'Mesaj istatistikleri' },
  { name: 'voice',                   desc: 'Ses istatistikleri' },
  { name: 'guard',                   desc: 'Sunucu koruma sistemi' },
  { name: 'listenroles',             desc: 'Dinlenen yetkili rolleri (tüm alt komutlar)' },
  { name: 'listenroles:add',         desc: 'Dinlenecek rol ekle' },
  { name: 'listenroles:remove',      desc: 'Dinlenen rolü kaldır' },
  { name: 'listenroles:list',        desc: 'Dinlenen rolleri listele' },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Komut erişim izinlerini yönetir')
    .addSubcommand(s => s
      .setName('ver')
      .setDescription('Bir role komut erişimi ver')
      .addStringOption(o => o
        .setName('komut')
        .setDescription('Komut adı (örn: leaderboard veya staff:status)')
        .setRequired(true)
        .setAutocomplete(true)
      )
      .addRoleOption(o => o.setName('rol').setDescription('Erişim verilecek rol').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('al')
      .setDescription('Bir rolün komut erişimini kaldır')
      .addStringOption(o => o
        .setName('komut')
        .setDescription('Komut adı')
        .setRequired(true)
        .setAutocomplete(true)
      )
      .addRoleOption(o => o.setName('rol').setDescription('Erişimi kaldırılacak rol').setRequired(true))
    )
    .addSubcommand(s => s
      .setName('liste')
      .setDescription('Komuta verilen rolleri listele')
      .addStringOption(o => o
        .setName('komut')
        .setDescription('Komut adı (boş = tüm izinler)')
        .setRequired(false)
        .setAutocomplete(true)
      )
    )
    .addSubcommand(s => s
      .setName('sifirla')
      .setDescription('Bir komutun tüm özel izinlerini sil')
      .addStringOption(o => o
        .setName('komut')
        .setDescription('Komut adı')
        .setRequired(true)
        .setAutocomplete(true)
      )
    )
    .addSubcommand(s => s
      .setName('komutlar')
      .setDescription('İzin verilebilir komutların listesini göster')
    )
    .addSubcommand(s => s
      .setName('herkes')
      .setDescription('Tüm komutları ve kimlerin kullanabildiğini göster')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'yonetici',

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const filtered = COMMAND_LIST
      .filter(c => c.name.includes(focused))
      .slice(0, 25)
      .map(c => ({ name: `${c.name} — ${c.desc}`, value: c.name }));
    await interaction.respond(filtered);
  },

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // ── ver ───────────────────────────────────────────────────
    if (sub === 'ver') {
      const cmdName = interaction.options.getString('komut');
      const rol     = interaction.options.getRole('rol');

      await grantRole(guildId, cmdName, rol.id);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x44cc88)
          .setTitle('✅ İzin Verildi')
          .addFields(
            { name: '📌 Komut', value: `\`${cmdName}\``, inline: true },
            { name: '🎭 Rol',   value: `<@&${rol.id}>`,  inline: true },
          )
          .setDescription(`<@&${rol.id}> artık \`/${cmdName}\` komutunu kullanabilir.`)
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── al ────────────────────────────────────────────────────
    if (sub === 'al') {
      const cmdName = interaction.options.getString('komut');
      const rol     = interaction.options.getRole('rol');

      const removed = await revokeRole(guildId, cmdName, rol.id);
      if (!removed) {
        return interaction.reply({
          content: `❌ <@&${rol.id}> rolünün \`/${cmdName}\` için izni zaten yok.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xff4444)
          .setTitle('🗑️ İzin Kaldırıldı')
          .addFields(
            { name: '📌 Komut', value: `\`${cmdName}\``, inline: true },
            { name: '🎭 Rol',   value: `<@&${rol.id}>`,  inline: true },
          )
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── liste ─────────────────────────────────────────────────
    if (sub === 'liste') {
      const cmdName = interaction.options.getString('komut');

      if (cmdName) {
        const roles = await getGrants(guildId, cmdName);
        if (!roles.length) {
          return interaction.reply({
            content: `📭 \`/${cmdName}\` için özel izin verilmemiş. Sadece ManageGuild yetkisi çalışır.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`🔑 \`/${cmdName}\` — İzinli Roller`)
            .setDescription(roles.map(r => `<@&${r}>`).join('\n'))
            .setFooter({ text: `${roles.length} rol` })
            .setTimestamp()],
          flags: MessageFlags.Ephemeral,
        });
      }

      // Tüm izinler
      const all = await getGrants(guildId);
      if (!Object.keys(all).length) {
        return interaction.reply({ content: '📭 Henüz özel izin tanımlanmamış.', flags: MessageFlags.Ephemeral });
      }

      const lines = Object.entries(all).map(([cmd, roles]) =>
        `**\`/${cmd}\`** → ${roles.map(r => `<@&${r}>`).join(', ')}`
      ).join('\n');

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🔑 Tüm Komut İzinleri')
          .setDescription(lines)
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── sifirla ───────────────────────────────────────────────
    if (sub === 'sifirla') {
      const cmdName = interaction.options.getString('komut');
      const count   = await resetGrants(guildId, cmdName);

      return interaction.reply({
        content: count > 0
          ? `✅ \`/${cmdName}\` için **${count}** rol izni silindi. Artık sadece ManageGuild çalışır.`
          : `❌ \`/${cmdName}\` için silinecek izin bulunamadı.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ── herkes ────────────────────────────────────────────────
    if (sub === 'herkes') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Sadece üst seviye komutlar (subcommand yok)
      const topLevel = COMMAND_LIST.filter(c => !c.name.includes(':'));

      // DB'den tüm grantları çek
      const allGrants = await getGrants(guildId);

      const rows = [];
      for (const cmd of topLevel) {
        const clientCmd = interaction.client.commands.get(cmd.name);
        const isGenel   = clientCmd?.category === 'genel';
        const isAdmin   = ADMIN_ONLY.includes(cmd.name);
        const grants    = allGrants[cmd.name] ?? [];

        let access;
        if (isGenel) {
          access = '🌍 Herkes';
        } else if (isAdmin) {
          access = '🔴 Yalnızca Administrator';
        } else if (grants.length) {
          access = grants.map(r => `<@&${r}>`).join(', ');
        } else {
          access = '🔒 Yalnızca Sunucu Sahibi';
        }

        rows.push({ cmd: cmd.name, access });
      }

      // Gruplara ayır
      const everyone  = rows.filter(r => r.access === '🌍 Herkes');
      const adminOnly = rows.filter(r => r.access === '🔴 Yalnızca Administrator');
      const granted   = rows.filter(r => r.access.includes('<@&'));
      const ownerOnly = rows.filter(r => r.access === '🔒 Yalnızca Sunucu Sahibi');

      const fmt = (list) => list.map(r => `\`/${r.cmd}\``).join(', ') || '*—*';
      const fmtGranted = (list) => list.map(r => `\`/${r.cmd}\` → ${r.access}`).join('\n') || '*—*';

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🔑 Komut Erişim Tablosu')
        .addFields(
          { name: '🌍 Herkes',                 value: fmt(everyone),        inline: false },
          { name: '🔴 Yalnızca Administrator', value: fmt(adminOnly),       inline: false },
          { name: '🎭 Role Açık',              value: fmtGranted(granted),  inline: false },
          { name: '🔒 Yalnızca Sunucu Sahibi', value: fmt(ownerOnly),       inline: false },
        )
        .setFooter({ text: 'Erişim vermek için: /permissions ver <komut> <rol>' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── komutlar ──────────────────────────────────────────────
    if (sub === 'komutlar') {
      const lines = COMMAND_LIST.map(c =>
        `\`/${c.name}\` — ${c.desc}`
      ).join('\n');

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x9966ff)
          .setTitle('📋 İzin Verilebilir Komutlar')
          .setDescription(lines)
          .setFooter({ text: 'Subkomut seviyesinde de izin verebilirsin (örn: staff:status)' })
          .setTimestamp()],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

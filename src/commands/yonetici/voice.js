const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { getUserVoiceLogs, getUserVoiceStats, getUser, formatTime } = require('../../utils/activityTracker');

function durationBar(seconds, maxSeconds) {
  const filled = Math.round((seconds / Math.max(maxSeconds, 1)) * 8);
  return '█'.repeat(filled) + '░'.repeat(8 - filled);
}

function buildEmbed(target, logs, stats, liveSession, page, totalPages) {
  const start = page * 5;
  const slice = logs.slice(start, start + 5);

  const totalSec    = Number(stats.total_seconds);
  const activeSec   = Number(stats.total_active_seconds ?? 0);
  const inactiveSec = Math.max(0, totalSec - activeSec);
  const avgSec      = Math.floor(Number(stats.avg_seconds));
  const maxDur      = Number(stats.longest_seconds);
  const sessions    = Number(stats.total_sessions);

  const sessionLines = slice.map((v, i) => {
    const joinTs   = Math.floor(new Date(v.joined_at).getTime() / 1000);
    const leftTs   = Math.floor(new Date(v.left_at).getTime() / 1000);
    const total    = Number(v.duration_seconds);
    const active   = Number(v.active_seconds ?? 0);
    const inactive = Math.max(0, total - active);
    const num      = `\`${String(start + i + 1).padStart(2, '0')}\``;
    return (
      `${num} **#${v.channel_name}** · ${formatTime(total)}\n` +
      `　　🎙️ Açık: **${formatTime(active)}**  ·  🔇 Kapalı: **${formatTime(inactive)}**\n` +
      `　　<t:${joinTs}:T> → <t:${leftTs}:T> · <t:${leftTs}:R>`
    );
  }).join('\n\n') || '*Oturum bulunamadı.*';

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${target.username} · Ses Oturumları`,
      iconURL: target.displayAvatarURL(),
    })
    .setColor(liveSession ? 0xff4444 : 0x44dd88)
    .addFields(
      { name: '🗂️ Oturum',     value: `${sessions}`,           inline: true },
      { name: '⏱️ Toplam',     value: formatTime(totalSec),    inline: true },
      { name: '📊 Ortalama',   value: formatTime(avgSec),      inline: true },
      { name: '🎙️ Mic Açık',  value: formatTime(activeSec),   inline: true },
      { name: '🔇 Mic Kapalı', value: formatTime(inactiveSec), inline: true },
      { name: '🏆 En Uzun',    value: formatTime(maxDur),      inline: true },
      { name: '📍 En Çok',     value: stats.top_channel ? `#${stats.top_channel}` : '—', inline: true },
    );

  if (liveSession) {
    const liveSec = Math.floor((Date.now() - parseInt(liveSession.voice_joined_at)) / 1000);

    const micIcon    = liveSession.serverMute ? '🔇 Sunucu mute'
      : liveSession.selfMute  ? '🎙️ Mikrofon kapalı'
      : '🎙️ Mikrofon açık';
    const deafIcon   = liveSession.serverDeaf ? ' · 🔕 Sunucu deaf'
      : liveSession.selfDeaf  ? ' · 🔕 Kulaklık kapalı'
      : '';
    const extraIcons = [
      liveSession.streaming ? '🖥️ Yayın var' : null,
      liveSession.camera    ? '📷 Kamera açık' : null,
    ].filter(Boolean).join(' · ');

    embed.addFields({
      name: '🔴 Şu An Canlı',
      value:
        `**#${liveSession.voice_channel_name ?? '?'}** · ${formatTime(liveSec)} süredir aktif\n` +
        `${micIcon}${deafIcon}${extraIcons ? ` · ${extraIcons}` : ''}`,
      inline: false,
    });
  }

  embed.addFields({ name: `📋 Oturumlar`, value: sessionLines, inline: false });
  embed.setFooter({ text: `Sayfa ${page + 1} / ${totalPages}  ·  ${sessions} oturum` });

  return embed;
}

function buildButtons(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('voice_prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId('voice_page')
      .setLabel(`${page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('voice_next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Kullanıcının ses oturumlarını gösterir')
    .addUserOption(opt => opt.setName('user').setDescription('Kullanıcı').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('adet').setDescription('Kaç oturum gösterilsin (max 50)').setMinValue(1).setMaxValue(50)
    ),
  category: 'yonetici',

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const limit  = interaction.options.getInteger('adet') ?? 25;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const [logs, stats, activityRow] = await Promise.all([
      getUserVoiceLogs(guildId, target.id, limit),
      getUserVoiceStats(guildId, target.id),
      getUser(guildId, target.id),
    ]);

    if (!logs.length) {
      return interaction.editReply({ content: `❌ **${target.username}** için ses logu bulunamadı.` });
    }

    // Anlık ses durumu
    const voiceState = interaction.guild.voiceStates.cache.get(target.id);
    const liveSession = activityRow?.voice_joined_at ? {
      ...activityRow,
      selfMute:   voiceState?.selfMute   ?? false,
      selfDeaf:   voiceState?.selfDeaf   ?? false,
      serverMute: voiceState?.serverMute ?? false,
      serverDeaf: voiceState?.serverDeaf ?? false,
      streaming:  voiceState?.streaming  ?? false,
      camera:     voiceState?.selfVideo  ?? false,
    } : null;

    const totalPages = Math.ceil(logs.length / 5);
    let page = 0;

    const reply = await interaction.editReply({
      embeds: [buildEmbed(target, logs, stats, liveSession, page, totalPages)],
      components: totalPages > 1 ? [buildButtons(page, totalPages)] : [],
    });

    if (totalPages <= 1) return;

    const collector = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 120_000,
    });

    collector.on('collect', async i => {
      if (i.customId === 'voice_prev' && page > 0) page--;
      else if (i.customId === 'voice_next' && page < totalPages - 1) page++;
      await i.update({
        embeds: [buildEmbed(target, logs, stats, liveSession, page, totalPages)],
        components: [buildButtons(page, totalPages)],
      });
    });

    collector.on('end', async () => {
      try { await reply.edit({ components: [] }); } catch {}
    });
  },
};

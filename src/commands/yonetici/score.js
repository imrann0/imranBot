const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { pool } = require('../../utils/database');
const { getScoreConfig, calcMessageScore } = require('../../utils/activityTracker');

async function setCfg(guildId, key, value) {
  await pool.query(
    `INSERT INTO guild_config (guild_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (guild_id, key) DO UPDATE SET value = $3`,
    [guildId, key, String(value)]
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('score')
    .setDescription('Puan sistemi ayarları')
    .addSubcommand(sub =>
      sub.setName('info')
        .setDescription('Mevcut puan sistemi bilgilerini gösterir')
    )
    .addSubcommand(sub =>
      sub.setName('messages')
        .setDescription('Mesaj puanlama ayarları')
        .addIntegerOption(o => o.setName('base').setDescription('Geçerli mesaj başına temel puan').setMinValue(0).setMaxValue(100))
        .addIntegerOption(o => o.setName('min_chars').setDescription('Sayılması için min karakter sayısı (spam engeli)').setMinValue(0).setMaxValue(500))
        .addIntegerOption(o => o.setName('min_words').setDescription('Sayılması için min kelime sayısı').setMinValue(0).setMaxValue(50))
        .addIntegerOption(o => o.setName('word_threshold').setDescription('Kelime bonusu için gereken kelime sayısı').setMinValue(1).setMaxValue(200))
        .addIntegerOption(o => o.setName('word_bonus').setDescription('Kelime eşiği aşıldığında eklenecek bonus puan').setMinValue(0).setMaxValue(100))
        .addIntegerOption(o => o.setName('char_threshold').setDescription('Karakter bonusu için gereken karakter sayısı').setMinValue(1).setMaxValue(2000))
        .addIntegerOption(o => o.setName('char_bonus').setDescription('Karakter eşiği aşıldığında eklenecek bonus puan').setMinValue(0).setMaxValue(100))
    )
    .addSubcommand(sub =>
      sub.setName('voice')
        .setDescription('Ses puanlama ayarları')
        .addIntegerOption(o => o.setName('per_minute').setDescription('Seste geçirilen her dakika için puan').setMinValue(0).setMaxValue(100).setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('logchannel')
        .setDescription('Puan log kanalını ayarla')
        .addChannelOption(o => o.setName('kanal').setDescription('Puanların loglanacağı kanal (boş bırakırsan sıfırlar)').setRequired(false))
    ),
  category: 'yonetici',

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();

    const guildId = interaction.guild.id;

    // ── /score info ────────────────────────────────────────────
    if (sub === 'info') {
      const cfg = await getScoreConfig(guildId);

      const msgFormula =
        `\`\`\`\n` +
        `Geçerlilik : karakter ≥ ${cfg.msg_min_chars} VE kelime ≥ ${cfg.msg_min_words}\n` +
        `Temel puan : +${cfg.msg_base}\n` +
        `Kelime bonusu: kelime ≥ ${cfg.msg_word_threshold} → +${cfg.msg_word_bonus}\n` +
        `Karakter bonusu: karakter ≥ ${cfg.msg_char_threshold} → +${cfg.msg_char_bonus}\n` +
        `Maksimum  : ${cfg.msg_base + cfg.msg_word_bonus + cfg.msg_char_bonus} puan/mesaj\n` +
        `\`\`\``;

      const examples = [
        { label: 'Kısa mesaj ("ok")', content: 'ok' },
        { label: `${cfg.msg_min_chars} karakter, ${cfg.msg_min_words} kelime (minimum)`, content: 'x'.repeat(cfg.msg_min_chars) },
        { label: `${cfg.msg_word_threshold} kelimeli mesaj`, content: ('kelime '.repeat(cfg.msg_word_threshold)).trim() },
        { label: `${cfg.msg_char_threshold} karakterli mesaj`, content: 'a'.repeat(cfg.msg_char_threshold) },
        { label: 'Hem kelime hem karakter bonusu', content: ('uzunkelime '.repeat(cfg.msg_word_threshold) + 'a'.repeat(cfg.msg_char_threshold)).trim() },
      ].map(e => {
        const pts = calcMessageScore(e.content, cfg);
        return `**${e.label}** → **${pts}p**`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setTitle('📊 Puan Sistemi Bilgilendirmesi')
        .setColor(0x9966ff)
        .setTimestamp()
        .addFields(
          {
            name: '💬 Mesaj Puanlama Formülü',
            value: msgFormula,
            inline: false,
          },
          {
            name: '📝 Örnekler',
            value: examples,
            inline: false,
          },
          {
            name: '🎙️ Ses Puanlama',
            value: [
              `Sadece **mikrofon açıkken** geçirilen süre sayılır — mute olunca sayaç durur.`,
              `Her **1 dakika** (mic açık) → **+${cfg.voice_per_min} puan**`,
              `**1 saat** mic açık → **+${(cfg.voice_per_min * 60).toFixed(1)} puan**`,
              `**8 saat** mic açık → **+${(cfg.voice_per_min * 60 * 8).toFixed(1)} puan**`,
              `Puan ses kanalından çıkıldığında hesaplanır.`,
            ].join('\n'),
            inline: false,
          },
          {
            name: '📌 Görev Puanlama',
            value: 'Görev oluşturulurken belirlenir (5–200 arası).\nGörevi tamamlayan her kişiye o puan eklenir.',
            inline: false,
          },
          {
            name: '⭐ Toplam Skor',
            value: '`Toplam = Mesaj Puanları + Ses Puanları + Görev Puanları`',
            inline: false,
          },
          {
            name: '⚙️ Mevcut Ayarlar',
            value:
              `**Mesaj:** temel **${cfg.msg_base}p** | min karakter **${cfg.msg_min_chars}** | min kelime **${cfg.msg_min_words}**\n` +
              `Kelime bonusu: ≥**${cfg.msg_word_threshold}** kelime → **+${cfg.msg_word_bonus}p**\n` +
              `Karakter bonusu: ≥**${cfg.msg_char_threshold}** karakter → **+${cfg.msg_char_bonus}p**\n` +
              `**Ses:** dakika başı **${cfg.voice_per_min}p**`,
            inline: false,
          },
        );

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /score messages ────────────────────────────────────────
    if (sub === 'messages') {
      const fields = {
        score_msg_base:           interaction.options.getInteger('base'),
        score_msg_min_chars:      interaction.options.getInteger('min_chars'),
        score_msg_min_words:      interaction.options.getInteger('min_words'),
        score_msg_word_threshold: interaction.options.getInteger('word_threshold'),
        score_msg_word_bonus:     interaction.options.getInteger('word_bonus'),
        score_msg_char_threshold: interaction.options.getInteger('char_threshold'),
        score_msg_char_bonus:     interaction.options.getInteger('char_bonus'),
      };

      const updated = [];
      for (const [key, val] of Object.entries(fields)) {
        if (val !== null) {
          await setCfg(guildId, key, val);
          updated.push(`\`${key.replace('score_msg_', '')}\` → **${val}**`);
        }
      }

      if (!updated.length) {
        return interaction.editReply({ content: '⚠️ Değiştirilecek bir ayar belirtmedin.' });
      }

      const cfg = await getScoreConfig(guildId);
      return interaction.editReply({
        content:
          `✅ **Mesaj puan ayarları güncellendi:**\n${updated.join('\n')}\n\n` +
          `Maksimum puan/mesaj: **${cfg.msg_base + cfg.msg_word_bonus + cfg.msg_char_bonus}**`,
      });
    }

    // ── /score voice ───────────────────────────────────────────
    if (sub === 'voice') {
      const perMin = interaction.options.getInteger('per_minute');
      await setCfg(guildId, 'score_voice_per_min', perMin);
      return interaction.editReply({
        content: `✅ Ses puanı güncellendi: dakika başı **${perMin} puan**.`,
      });
    }

    // ── /score logchannel ──────────────────────────────────────
    if (sub === 'logchannel') {
      const ch = interaction.options.getChannel('kanal');
      if (ch) {
        await setCfg(guildId, 'points_log_channel', ch.id);
        return interaction.editReply({
          content: `✅ Puan log kanalı ${ch} olarak ayarlandı.`,
        });
      } else {
        await pool.query(`DELETE FROM guild_config WHERE guild_id = $1 AND key = 'points_log_channel'`, [guildId]);
        return interaction.editReply({
          content: '✅ Puan log kanalı kaldırıldı.',
        });
      }
    }
  },
};

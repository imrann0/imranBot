const { EmbedBuilder } = require('discord.js');

module.exports = {
  name: 'help',
  aliases: ['yardim', 'komutlar'],
  cooldown: 10, // saniye
  description: 'Prefix komutlarını listeler',
  async execute(message, args, client) {
    const embed = new EmbedBuilder()
      .setColor(0x9966ff)
      .setTitle(`📖 ${client.user.username} — Prefix Komutları`)
      .setDescription('Prefix: `i?`')
      .addFields(
        {
          name: '💕 Eğlence',
          value: [
            '`i?ship @kişi1 @kişi2` — İki kişinin uyumunu ölçer',
            '`i?ship @kişi` — Seninle o kişinin uyumunu ölçer',
            '',
            '*Alias: `i?ask`, `i?sevgi`*',
          ].join('\n'),
          inline: false,
        },
        {
          name: '📋 Görevler',
          value: [
            '`i?gorevlerim` — Aktif görevlerini ve ilerlemeni gösterir',
            '',
            '*Alias: `i?görevlerim`, `i?tasks`, `i?gorev`*',
          ].join('\n'),
          inline: false,
        },
        {
          name: '❓ Diğer',
          value: '`i?help` — Bu menüyü gösterir',
          inline: false,
        },
      )
      .setFooter({ text: `${client.user.username} • Slash komutlar için / kullan` })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  },
};

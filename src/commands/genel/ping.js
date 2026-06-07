const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Botun gecikmesini gösterir'),
  category: 'genel',
  async execute(interaction) {
    const latency = Date.now() - interaction.createdTimestamp;
    const embed = new EmbedBuilder()
      .setTitle('🏓 Pong!')
      .addFields(
        { name: 'Gecikme', value: `${latency}ms`, inline: true },
        { name: 'API', value: `${interaction.client.ws.ping}ms`, inline: true },
      )
      .setColor(0x9966ff);
    await interaction.reply({ embeds: [embed] });
  },
};

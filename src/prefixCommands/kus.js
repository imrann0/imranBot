module.exports = {
  name: 'kus',
  cooldown: 3600, // 1 saat
  description: 'önemli duyuru',
  async execute(message) {
    await message.channel.send('BEN FEMBOYUM YAKIŞIKLI ERKEKLER DM :)');
  },
};

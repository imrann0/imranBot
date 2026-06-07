require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { REST, Routes } = require('discord.js');
const { Agent } = require('undici');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'src', 'commands');
const categories = fs.readdirSync(commandsPath);

for (const category of categories) {
  const categoryPath = path.join(commandsPath, category);
  if (!fs.statSync(categoryPath).isDirectory()) continue;
  const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const command = require(path.join(categoryPath, file));
    if (command.data) commands.push(command.data.toJSON());
  }
}

const rest = new REST({ agent: new Agent({ connect: { rejectUnauthorized: false } }) }).setToken(process.env.TOKEN);

// Belirli bir sunucuya hızlı deploy için: node deploy-commands.js <GUILD_ID>
const targetGuildId = process.argv[2];

(async () => {
  try {
    if (targetGuildId) {
      console.log(`${commands.length} komut guild ${targetGuildId} için deploy ediliyor...`);
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, targetGuildId),
        { body: commands },
      );
      console.log(`✅ Komutlar ${targetGuildId} sunucusuna anında deploy edildi!`);
    } else {
      console.log(`${commands.length} slash komutu global olarak deploy ediliyor...`);
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands },
      );
      console.log('✅ Komutlar tüm sunuculara deploy edildi! (1 saate kadar yayılır)');
    }
    commands.forEach(c => console.log(`  • /${c.name}`));
  } catch (error) {
    console.error(error);
  }
})();

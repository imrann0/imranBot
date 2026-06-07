require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { Agent } = require('undici');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Türkiye ISP SSL bypass (geçici)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  rest: { agent: insecureAgent },
});

client.commands = new Collection();

// Kategorilere göre komutları yükle
const commandsPath = path.join(__dirname, 'src', 'commands');
const categories = fs.readdirSync(commandsPath);
for (const category of categories) {
  const categoryPath = path.join(commandsPath, category);
  if (!fs.statSync(categoryPath).isDirectory()) continue;
  const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const command = require(path.join(categoryPath, file));
    if (command.data && command.execute) {
      client.commands.set(command.data.name, command);
    }
  }
}

// Eventleri yükle
const eventsPath = path.join(__dirname, 'src', 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));
for (const file of eventFiles) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

client.login(process.env.TOKEN);

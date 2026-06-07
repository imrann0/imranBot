const { addMessage, logMessage } = require('../utils/activityTracker');
const { isStaff } = require('../utils/staffRoles');
const { isBlocked } = require('../utils/blockedChannels');
const { getConfig, logPartnership, checkPartnershipTasks, notifyTaskReady } = require('../utils/taskManager');
const { pool } = require('../utils/database');
const fs   = require('fs');
const path = require('path');

const PREFIX = 'i?';

// Prefix komutlarını yükle
const prefixCommands = new Map();
const prefixDir = path.join(__dirname, '../prefixCommands');
for (const file of fs.readdirSync(prefixDir).filter(f => f.endsWith('.js'))) {
  const cmd = require(path.join(prefixDir, file));
  prefixCommands.set(cmd.name, cmd);
  if (cmd.aliases) cmd.aliases.forEach(a => prefixCommands.set(a, cmd));
}

// Cooldown takibi: Map<cmdName, Map<userId, lastUsedTimestamp>>
const cooldowns = new Map();

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.member) return;

    // ── Prefix komut kontrolü ─────────────────────────────────
    if (message.content.startsWith(PREFIX)) {
      const args    = message.content.slice(PREFIX.length).trim().split(/\s+/);
      const cmdName = args.shift().toLowerCase();
      const cmd     = prefixCommands.get(cmdName);

      if (cmd) {
        // ── Cooldown kontrolü ──────────────────────────────────
        const cooldownSec = cmd.cooldown ?? 5; // varsayılan 5 saniye
        if (cooldownSec > 0) {
          if (!cooldowns.has(cmd.name)) cooldowns.set(cmd.name, new Map());
          const timestamps = cooldowns.get(cmd.name);
          const now        = Date.now();
          const cooldownMs = cooldownSec * 1000;

          if (timestamps.has(message.author.id)) {
            const expireTime = timestamps.get(message.author.id) + cooldownMs;
            if (now < expireTime) {
              const remaining = ((expireTime - now) / 1000).toFixed(1);
              const reply = await message.reply(
                `⏳ Bu komutu tekrar kullanmak için **${remaining} saniye** beklemelisin.`
              ).catch(() => {});
              if (reply) setTimeout(() => reply.delete().catch(() => {}), 4000);
              return;
            }
          }

          timestamps.set(message.author.id, now);
          // Belleği temizle (cooldown bitince sil)
          setTimeout(() => timestamps.delete(message.author.id), cooldownMs);
        }
        // ───────────────────────────────────────────────────────

        try {
          await cmd.execute(message, args, message.client);
        } catch (err) {
          console.error(`[Prefix] ${cmdName} hatası:`, err.message);
          await message.reply('❌ Bir hata oluştu!').catch(() => {});
        }
      }
      return; // Prefix komutsa aktivite sayma
    }

    // ── Aktivite takibi (sadece staff) ───────────────────────
    if (!await isStaff(message.member)) return;
    if (await isBlocked(message.guild.id, message.channel.id)) return;

    const guildId     = message.guild.id;
    const { id: userId, username } = message.author;
    const channelId   = message.channel.id;
    const channelName = message.channel.name ?? 'bilinmiyor';

    let content = message.content?.trim() || '';
    if (!content && message.attachments.size > 0) content = `[${message.attachments.size} dosya/resim]`;
    if (!content && message.embeds.length  > 0) content = '[embed]';
    if (!content && message.stickers.size  > 0) content = `[sticker: ${message.stickers.first().name}]`;
    if (!content) content = '[bilinmeyen içerik]';

    let replyToUserId = null, replyToUsername = null, replyToContent = null;
    if (message.reference?.messageId) {
      try {
        const replied   = await message.channel.messages.fetch(message.reference.messageId);
        replyToUserId   = replied.author.id;
        replyToUsername = replied.author.username;
        replyToContent  = replied.content?.slice(0, 200) || '[embed/dosya]';
      } catch {}
    }

    const msgScore = await addMessage(guildId, userId, username, channelId, channelName, message.content?.trim() || '');
    await logMessage({ guildId, userId, username, channelId, channelName, content, replyToUserId, replyToUsername, replyToContent, score: msgScore ?? 0 });

    // Her 10 mesajda bir görev gereksinimi kontrolü
    const msgCount = await pool.query(
      `SELECT messages FROM activity WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    ).then(r => r.rows[0]?.messages ?? 0).catch(() => 0);
    if (msgCount % 10 === 0) {
      notifyTaskReady(message.client, guildId, userId, username).catch(() => {});
    }

    // ── Partnerlik kanalı kontrolü ────────────────────────────
    const partnershipChannelId = await getConfig(guildId, 'partnership_channel');
    if (partnershipChannelId && channelId === partnershipChannelId) {
      await logPartnership(guildId, userId, username, message.id);
      await checkPartnershipTasks(message.client, guildId, userId, username, message.guild).catch(e =>
        console.error('[Partnerlik]', e.message)
      );
    }
  },
};

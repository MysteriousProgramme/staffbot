const { Events, AuditLogEvent } = require('discord.js');
const config = require('../config');
const db = require('./db');
const ticketWatch = require('./ticketWatch');
const gameChat = require('./gameChat');
const observe = require('./observe');

// key: `${userId}:${channelId}` -> last counted timestamp
const cooldowns = new Map();

function onCooldown(userId, channelId) {
  const key = `${userId}:${channelId}`;
  const last = cooldowns.get(key) ?? 0;
  const window = config.tracking.messageCooldownSeconds * 1000;
  if (Date.now() - last < window) return true;
  cooldowns.set(key, Date.now());
  return false;
}

setInterval(() => {
  const cutoff = Date.now() - config.tracking.messageCooldownSeconds * 1000 * 4;
  for (const [k, v] of cooldowns) if (v < cutoff) cooldowns.delete(k);
}, 10 * 60 * 1000).unref();

const isTrackedStaff = (guildId, userId) => Boolean(db.getStaff(guildId, userId));

function register(client) {
  // ---------- messages ----------
  client.on(Events.MessageCreate, (message) => {
    try {
      if (!message.guild) return;

      // The bridge posts as a bot or webhook, so this has to run BEFORE the
      // bot-author check that everything else depends on.
      if (gameChat.handleMessage(message)) return;

      if (message.author.bot) return;

      // Ticket King channels are measured by ticket metrics (claims,
      // response time, who did the talking), not by raw message count —
      // otherwise a chatty ticket would pay out twice.
      if (ticketWatch.handleMessage(message)) return;

      if (!isTrackedStaff(message.guildId, message.author.id)) return;
      if ((message.content?.trim().length ?? 0) < config.tracking.minMessageLength) return;

      // Presence and conduct are recorded for EVERY channel, including ignored
      // ones — an ignored channel still proves the person was around, and tone
      // in a joke channel is still tone. Only the scored message counts below
      // respect the ignore list.
      observe.notePresence(message.guildId, message.author.id, message.channelId, message.createdTimestamp);
      observe.noteConduct(message.guildId, message.author.id, message.channelId, message.content);

      if (config.channels.ignored.includes(message.channelId)) return;
      if (onCooldown(message.author.id, message.channelId)) return;

      const metric = config.channels.staffChannels.includes(message.channelId)
        ? 'staffPresence'
        : 'publicActivity';
      db.bumpMetric(message.guildId, message.author.id, metric);
    } catch (e) {
      console.error('[tracking] message error:', e);
    }
  });

  // ---------- moderation actions ----------
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    try {
      const executorId = entry.executorId;
      if (!executorId || executorId === client.user.id) return;
      if (!isTrackedStaff(guild.id, executorId)) return;

      const counted = [
        AuditLogEvent.MemberBanAdd,
        AuditLogEvent.MemberKick,
        AuditLogEvent.MemberBanRemove,
      ];
      if (config.tracking.countMessageDeletes) {
        counted.push(AuditLogEvent.MessageDelete, AuditLogEvent.MessageBulkDelete);
      }

      let isModAction = counted.includes(entry.action);

      // Timeouts arrive as a MemberUpdate touching communication_disabled_until
      if (
        !isModAction &&
        entry.action === AuditLogEvent.MemberUpdate &&
        entry.changes?.some((c) => c.key === 'communication_disabled_until')
      ) {
        isModAction = true;
      }

      if (isModAction) db.bumpMetric(guild.id, executorId, 'modActions');
    } catch (e) {
      console.error('[tracking] audit log error:', e);
    }
  });

}

module.exports = { register };

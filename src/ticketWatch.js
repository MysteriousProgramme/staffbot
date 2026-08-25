const { Events, ChannelType } = require('discord.js');
const config = require('../config');
const db = require('./db');

/**
 * Ticket King integration.
 *
 * Staffbot does not run tickets. Ticket King does. This module watches the
 * category Ticket King creates its channels in and works out, without parsing
 * a single embed, who actually handled each ticket:
 *
 *   channel appears in the category   -> a ticket opened
 *   first staff message in it         -> response time for that person
 *   every staff message               -> a participation count
 *   channel disappears                -> ticket closed, credit whoever did the work
 *
 * Ticket King's exact wording can change with any update and this keeps
 * working, because it only depends on channels appearing and disappearing.
 *
 * The one optional bit of parsing is claim detection (config.ticketKing
 * .claimPattern). If it matches, the claimer is credited outright. If it never
 * matches, nothing breaks — credit falls back to whoever did the most talking.
 */

const TK = () => config.ticketKing;

const watchedCategory = (channel) => {
  const ids = TK()?.categoryIds ?? [];
  return Boolean(channel?.parentId && ids.includes(channel.parentId));
};

const isTrackedStaff = (guildId, userId) => Boolean(db.getStaff(guildId, userId));

// ---------------------------------------------------------------
// Opening
// ---------------------------------------------------------------

function noteOpened(channel) {
  return db.noteTicketOpened({
    guildId: channel.guildId ?? channel.guild?.id,
    channelId: channel.id,
    channelName: channel.name,
    openerId: openerFromOverwrites(channel),
    openedAt: channel.createdTimestamp ?? Date.now(),
  });
}

/**
 * Ticket King gives the person who opened the ticket an explicit member-level
 * permission overwrite. Everything else in the category is role-level, so the
 * lone member overwrite that is not a bot is the opener. Falls back to null
 * and gets filled in later by the first non-staff message.
 */
function openerFromOverwrites(channel) {
  try {
    const memberOverwrites = [...(channel.permissionOverwrites?.cache?.values() ?? [])].filter(
      (o) => o.type === 1 // 1 = member
    );
    const botId = String(TK()?.botUserId ?? '');
    const candidates = memberOverwrites
      .map((o) => o.id)
      .filter((id) => id !== botId && !isTrackedStaff(channel.guildId, id));
    return candidates.length === 1 ? candidates[0] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// Claim detection (optional, best-effort)
// ---------------------------------------------------------------

let claimRe = null;
function claimRegex() {
  if (claimRe !== null) return claimRe;
  const src = TK()?.claimPattern;
  if (!src) return (claimRe = false);
  try {
    claimRe = new RegExp(src, 'i');
  } catch (e) {
    console.error(`[tickets] claimPattern is not a valid regex, claim detection off: ${e.message}`);
    claimRe = false;
  }
  return claimRe;
}

/** Returns a claimer user ID from a Ticket King message, or null. */
function detectClaim(message) {
  const re = claimRegex();
  if (!re) return null;

  const haystacks = [message.content || ''];
  for (const embed of message.embeds ?? []) {
    if (embed.title) haystacks.push(embed.title);
    if (embed.description) haystacks.push(embed.description);
    if (embed.footer?.text) haystacks.push(embed.footer.text);
    for (const f of embed.fields ?? []) haystacks.push(`${f.name} ${f.value}`);
  }

  for (const text of haystacks) {
    const m = text.match(re);
    if (!m) continue;
    const id = m.slice(1).find((g) => g && /^\d{15,20}$/.test(g));
    if (id) return id;
  }
  return null;
}

// ---------------------------------------------------------------
// Messages
// ---------------------------------------------------------------

/**
 * Called from tracking.js. Returns true if this message was inside a ticket,
 * so the normal activity tracker knows to skip it — ticket work is measured
 * by ticket metrics, not by message count.
 */
function handleMessage(message) {
  if (!TK()?.enabled) return false;
  if (!watchedCategory(message.channel)) return false;

  let ticket = db.getTicket(message.channelId);
  if (!ticket) ticket = noteOpened(message.channel); // bot was offline when it opened

  db.touchTicket(message.channelId);

  // Ticket King's own messages: only useful for spotting a claim.
  if (message.author.bot) {
    if (String(message.author.id) === String(TK().botUserId)) {
      const claimer = detectClaim(message);
      if (claimer && !ticket.claimed_by && isTrackedStaff(message.guildId, claimer)) {
        db.setClaim(message.channelId, claimer);
      }
    }
    return true;
  }

  const staff = isTrackedStaff(message.guildId, message.author.id);

  if (!staff) {
    // First human who is not staff is the person the ticket is for.
    if (!ticket.opener_id) db.setOpener(message.channelId, message.author.id);
    return true;
  }

  // Staff replied.
  db.bumpParticipant(message.channelId, message.author.id);

  if (!ticket.first_response_at) {
    const waitSec = db.recordFirstResponse(ticket, message.author.id);
    if (waitSec !== null) {
      db.bumpMetric(message.guildId, message.author.id, 'responseTotalSec', waitSec);
      db.bumpMetric(message.guildId, message.author.id, 'responseCount', 1);
    }
  }

  return true;
}

// ---------------------------------------------------------------
// Closing
// ---------------------------------------------------------------

/**
 * Who gets the ticketsHandled credit?
 *
 *   1. The claimer, if Ticket King's /claim was detected. They owned it.
 *   2. Otherwise the staff member who sent the most messages, provided they
 *      cleared minMessagesToCredit.
 *   3. Otherwise nobody — a ticket where no staff said anything meaningful
 *      should not pay out.
 *
 * Note this is deliberately NOT "whoever closed it". Closing is one click and
 * would be the easiest number in the whole system to farm; doing the talking
 * is not.
 */
function decideCredit(guildId, ticket) {
  if (ticket.claimed_by && isTrackedStaff(guildId, ticket.claimed_by)) {
    return [ticket.claimed_by];
  }

  const parts = db
    .getParticipants(ticket.channel_id)
    .filter((p) => isTrackedStaff(guildId, p.user_id))
    .filter((p) => p.messages >= (TK()?.minMessagesToCredit ?? 3));

  if (!parts.length) return [];
  return TK()?.creditEveryone ? parts.map((p) => p.user_id) : [parts[0].user_id];
}

function closeTicket(guildId, ticket) {
  const credited = decideCredit(guildId, ticket);
  for (const userId of credited) {
    db.bumpMetric(guildId, userId, 'ticketsHandled');
  }
  db.closeTicket(ticket.channel_id, credited[0] ?? null);
  return credited;
}

// ---------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------

/**
 * The bot runs on a PC, so it will miss events every time that PC sleeps.
 * On boot: register ticket channels that appeared while we were away, and
 * settle up any ticket whose channel has since vanished.
 */
async function reconcile(client) {
  if (!TK()?.enabled) return;

  let discovered = 0;
  let settled = 0;

  for (const guild of client.guilds.cache.values()) {
    for (const categoryId of TK().categoryIds ?? []) {
      const category = await guild.channels.fetch(categoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) continue;

      for (const channel of category.children?.cache?.values() ?? []) {
        if (!channel.isTextBased()) continue;
        if (!db.getTicket(channel.id)) {
          noteOpened(channel);
          discovered++;
        }
      }
    }

    // Tickets we think are open but whose channel is gone = closed while away.
    for (const ticket of db.listOpenTickets(guild.id)) {
      const exists = await guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (exists) continue;
      closeTicket(guild.id, ticket);
      settled++;
    }
  }

  if (discovered || settled) {
    console.log(`[tickets] reconciled: ${discovered} found in progress, ${settled} closed while offline`);
  }

  const anyGuild = client.guilds.cache.first();
  if (anyGuild) {
    const closed = db.listOpenTickets(anyGuild.id).length;
    console.log(
      `[tickets] watching ${TK().categoryIds?.length ?? 0} categor${
        (TK().categoryIds?.length ?? 0) === 1 ? 'y' : 'ies'
      } · ${closed} ticket(s) currently open · claims detected so far: ${db.claimsSeen(anyGuild.id)}`
    );
  }
}

// ---------------------------------------------------------------

function register(client) {
  if (!TK()?.enabled) {
    console.log('[tickets] Ticket King integration is off');
    return;
  }

  client.on(Events.ChannelCreate, (channel) => {
    try {
      if (!watchedCategory(channel) || !channel.isTextBased()) return;
      noteOpened(channel);
    } catch (e) {
      console.error('[tickets] channel create:', e.message);
    }
  });

  client.on(Events.ChannelDelete, (channel) => {
    try {
      const ticket = db.getTicket(channel.id);
      if (!ticket || ticket.state !== 'open') return;
      const credited = closeTicket(channel.guildId ?? channel.guild?.id, ticket);
      console.log(
        `[tickets] ${channel.name} closed · credited ${credited.length ? credited.join(', ') : 'nobody'}`
      );
    } catch (e) {
      console.error('[tickets] channel delete:', e.message);
    }
  });

  client.once(Events.ClientReady, (c) => {
    reconcile(c).catch((e) => console.error('[tickets] reconcile failed:', e));
  });
}

module.exports = { register, handleMessage, decideCredit, detectClaim, closeTicket };

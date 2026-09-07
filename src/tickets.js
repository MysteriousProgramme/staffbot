const {
  Events,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const config = require('../config');
const db = require('./db');
const R = require('./ranks');
const transcript = require('./transcript');

/**
 * Staffbot's own ticket system.
 *
 * The older ticketWatch.js infers what happened inside somebody else's bot's
 * channels. This module owns the whole lifecycle instead — it makes the
 * channel, it handles the claim button, it closes the thing — so the numbers
 * that feed a trial score stop being guesses:
 *
 *   ticketsHandled   the claimer is a button press, not a regex on an embed
 *   responseSpeed    measured from a timestamp we wrote ourselves
 *
 * Everything still lands in the same `tickets` table the watcher used, so
 * /review, /staffstats and /promotions need to know nothing about any of this.
 */

const T = () => config.tickets ?? {};

const PRIORITIES = {
  low: { label: 'Low', emoji: '🔵', prefix: '', color: 0x60a5fa },
  normal: { label: 'Normal', emoji: '⚪', prefix: '', color: config.colors.ticket },
  high: { label: 'High', emoji: '🟠', prefix: '🟠-', color: 0xfb923c },
  urgent: { label: 'Urgent', emoji: '🔴', prefix: '🔴-', color: 0xef4444 },
};

const isTrackedStaff = (guildId, userId) => Boolean(db.getStaff(guildId, userId));

const typeByKey = (key) => (T().types ?? []).find((t) => t.key === key) ?? null;

/** Every category a ticket of ours can legitimately be sitting in. */
function ticketCategoryIds() {
  const ids = (T().types ?? []).map((t) => t.categoryId).filter(Boolean);
  if (T().escalationCategoryId) ids.push(T().escalationCategoryId);
  return ids;
}

/**
 * Who is allowed to work tickets. Deliberately broader than the configured
 * staffRoleIds: anyone already on the rank ladder is staff by definition, and
 * making people maintain the same list in two places is how it ends up wrong.
 */
function isTicketStaff(member) {
  if (!member) return false;
  if (R.isOverride(member)) return true;
  if (R.memberRankIndex(member) >= 0) return true;
  return (T().staffRoleIds ?? []).some((id) => member.roles.cache.has(id));
}

/**
 * Is this a server emoji rather than a plain unicode one?
 *
 * It matters because Discord renders them in only some places. Message text,
 * embed descriptions and embed field names resolve `<:name:id>` into the
 * picture. Embed TITLES, author lines and footers do not — they print the raw
 * `<:name:id>` text at the reader, which looks like a bug and is why the
 * opening embed keeps custom emoji out of its title.
 */
const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;
const isCustomEmoji = (e) => CUSTOM_EMOJI.test(String(e ?? ''));

/**
 * May this person let go of a claim that is not theirs?
 *
 * A claim is the record of who owns a piece of work, and it decides who gets
 * the ticketsHandled credit for it. Anyone being able to drop or reassign
 * somebody else's claim makes that record worthless — and worse, it is silent:
 * the person who did the work just stops being the claimer.
 *
 * So the claimer can release their own, and manageStaff (Head Mod and above,
 * plus the override roles) can release anyone's — because someone does
 * eventually go offline still holding a ticket, and that has to be fixable.
 *
 * Returns null when allowed, or a sentence explaining the refusal.
 */
function claimReleaseBlocked(member, ticket) {
  if (!ticket?.claimed_by) return null;
  if (String(ticket.claimed_by) === String(member?.id)) return null;
  if (R.meetsRequirement(member, config.permissions.manageStaff)) return null;

  const rank = R.rankByKey(config.permissions.manageStaff)?.name ?? 'a senior staff member';
  return (
    `<@${ticket.claimed_by}> is handling this one. Ask them to unclaim it, ` +
    `or a ${rank} can take it off them.`
  );
}

const pad = (n) => String(n).padStart(T().numberPadding ?? 4, '0');

function channelNameFor(number, priority) {
  const p = PRIORITIES[priority] ?? PRIORITIES.normal;
  return `${p.prefix}ticket-${pad(number)}`;
}

// ---------------------------------------------------------------
// Credit
// ---------------------------------------------------------------

/**
 * Who gets the ticketsHandled credit?
 *
 *   1. The claimer. They put their name on it.
 *   2. Otherwise the staff member who sent the most messages, provided they
 *      cleared minMessagesToCredit.
 *   3. Otherwise nobody.
 *
 * Note this is deliberately NOT "whoever closed it". Closing is one click and
 * would be the easiest number in the whole system to farm; doing the talking
 * is not. ticketWatch.js shares this function so the legacy watcher and the
 * native system can never drift into crediting different people.
 */
function decideCredit(guildId, ticket, opts = {}) {
  const minMessages = opts.minMessagesToCredit ?? 3;
  const creditEveryone = opts.creditEveryone ?? false;

  if (ticket.claimed_by && isTrackedStaff(guildId, ticket.claimed_by)) {
    return [ticket.claimed_by];
  }

  const parts = db
    .getParticipants(ticket.channel_id)
    .filter((p) => isTrackedStaff(guildId, p.user_id))
    .filter((p) => p.messages >= minMessages);

  if (!parts.length) return [];
  return creditEveryone ? parts.map((p) => p.user_id) : [parts[0].user_id];
}

// ---------------------------------------------------------------
// Messages inside a ticket
// ---------------------------------------------------------------

/**
 * Called from tracking.js. Returns true if this message was inside one of our
 * tickets, so the normal activity tracker knows to leave it alone — ticket
 * work is paid out in ticket metrics, and counting it as chat as well would
 * pay twice for the same hour.
 */
function handleMessage(message) {
  if (!T().enabled) return false;

  const ticket = db.getTicket(message.channelId);
  if (!ticket || ticket.source !== 'native') return false;

  db.touchTicket(message.channelId);
  if (message.author.bot) return true;

  if (!isTrackedStaff(message.guildId, message.author.id)) {
    // The opener is set at creation, but a ticket opened on someone else's
    // behalf can still be corrected by whoever actually turns up to talk.
    if (!ticket.opener_id) db.setOpener(message.channelId, message.author.id);
    return true;
  }

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
// Opening
// ---------------------------------------------------------------

/**
 * Reasons this person may not open a ticket right now. Returns a string to
 * show them, or null if they are clear. Checked before anything is created,
 * so a rejected attempt leaves no channel and no row behind.
 */
function openBlockedReason(guild, userId) {
  if (!T().enabled) return 'The ticket system is turned off.';

  const banned = db.ticketBlacklistEntry(guild.id, userId);
  if (banned) {
    return `You are blocked from opening tickets.${banned.reason ? `\n> ${banned.reason}` : ''}`;
  }

  const max = T().maxOpenPerUser ?? 1;
  if (max > 0) {
    const open = db.countOpenTicketsBy(guild.id, userId);
    if (open >= max) {
      return `You already have ${open === 1 ? 'a ticket' : `${open} tickets`} open. Use ${
        open === 1 ? 'it' : 'one of them'
      } instead of opening another.`;
    }
  }

  const cooldown = (T().cooldownSeconds ?? 0) * 1000;
  if (cooldown > 0) {
    const last = db.lastTicketOpenedAt(guild.id, userId);
    const waited = Date.now() - last;
    if (last && waited < cooldown) {
      const left = Math.ceil((cooldown - waited) / 1000);
      const mins = Math.floor(left / 60);
      return `You opened a ticket very recently. Try again in ${
        mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${left} seconds`
      }.`;
    }
  }

  return null;
}

function overwritesFor(guild, openerId, type) {
  const allow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  const rows = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    // Without this the bot can lock itself out of the channel it just made,
    // whenever its own role is not one of the configured staff roles.
    { id: guild.client.user.id, allow: [...allow, PermissionFlagsBits.ManageChannels] },
  ];

  if (openerId) rows.push({ id: openerId, allow });

  // A type may narrow who can see it, and narrowing REPLACES the global list
  // rather than adding to it. That is the whole point: a report about a Staff
  // Team member must not be readable by the Staff Team, and it would be if the
  // two lists were merged.
  const base = type?.staffRoleIds ?? T().staffRoleIds ?? [];
  const staffRoles = new Set([...base, ...(type?.pingRoleIds ?? [])]);

  for (const id of staffRoles) {
    if (guild.roles.cache.has(id)) rows.push({ id, allow });
  }

  return rows;
}

/**
 * The roles that can see a ticket of this type. Exported so the config check
 * can say out loud who ends up with access, rather than leaving it to be
 * discovered by the person being reported.
 */
function audienceFor(type) {
  const base = type?.staffRoleIds ?? T().staffRoleIds ?? [];
  return [...new Set([...base, ...(type?.pingRoleIds ?? [])])];
}

// Users, GuildMembers and the odd bare {id} all end up in these embeds.
// Reaching for the wrong property on one of them throws inside an interaction
// handler, where the only symptom is "This interaction failed".
const nameOf = (u) => u?.displayName ?? u?.user?.username ?? u?.username ?? 'Someone';

function avatarOf(u) {
  try {
    if (typeof u?.displayAvatarURL === 'function') return u.displayAvatarURL();
    if (typeof u?.user?.displayAvatarURL === 'function') return u.user.displayAvatarURL();
  } catch {
    /* partials and mocks */
  }
  return undefined;
}

/**
 * A one-line event: an avatar, a sentence, a colour down the side. Claiming and
 * unclaiming happen constantly, and a full titled embed for each one buries the
 * actual conversation under the bot talking about itself.
 */
function notice(color, text, iconURL) {
  const author = { name: String(text).slice(0, 256) };
  if (iconURL) author.iconURL = iconURL;
  return new EmbedBuilder().setColor(color).setAuthor(author);
}

const PIN_FOOTER = 'Staff — use the buttons below';
const F_STATUS = 'Status';
const F_PRIORITY = 'Priority';

/**
 * The two fields at the top of the pinned message, rebuilt whenever anything
 * about the ticket changes. Scrolling to the top of a long ticket should
 * answer "whose is this and how urgent" without reading a word of the thread.
 *
 * The claimer is a raw mention rather than a resolved name: field values render
 * mentions, so nothing has to be fetched to keep this current.
 */
function headerFields(ticket) {
  const p = PRIORITIES[ticket.priority] ?? PRIORITIES.normal;
  return [
    {
      name: F_STATUS,
      value: ticket.claimed_by ? `🟢 <@${ticket.claimed_by}>` : '🟡 Waiting for staff',
      inline: true,
    },
    { name: F_PRIORITY, value: `${p.emoji} ${p.label}`, inline: true },
  ];
}

/**
 * High and urgent override the type's own colour. A red type badge is
 * decoration; a red URGENT ticket is information, and it wins.
 */
function accentFor(ticket, type) {
  const key = ticket.priority ?? 'normal';
  if (key === 'urgent' || key === 'high') return PRIORITIES[key].color;
  return type?.color ?? PRIORITIES.normal.color;
}

function openingEmbed(ticket, type, opener, answers) {
  // A server emoji in the title would print as literal <:name:id>, so it goes
  // to the front of the description instead, where Discord does resolve it.
  const emoji = type?.emoji ?? '🎫';
  const custom = isCustomEmoji(emoji);

  const embed = new EmbedBuilder()
    .setColor(accentFor(ticket, type))
    .setAuthor({ name: nameOf(opener), iconURL: avatarOf(opener) })
    .setTitle(`${custom ? '' : emoji + '  '}${type?.label ?? 'Ticket'} · #${pad(ticket.number)}`)
    .setDescription(
      `${custom ? emoji + ' ' : ''}Thanks for reaching out — a staff member will pick this up as soon as one is free.\n` +
        '-# Screenshots, usernames, timestamps: the more that is in here, the faster this goes.'
    )
    .addFields(headerFields(ticket))
    .setFooter({ text: PIN_FOOTER })
    .setTimestamp(ticket.opened_at);

  for (const q of (type?.questions ?? []).slice(0, 5)) {
    const value = answers?.[q.id];
    if (!value) continue;
    // Short answers pair up two to a row; a wall of text gets the full width
    // and a quote bar so it reads as their words rather than the bot's.
    const paragraph = q.style === 'paragraph';
    embed.addFields({
      name: q.label.slice(0, 256),
      value: (paragraph ? `>>> ${value}` : value).slice(0, 1024),
      inline: !paragraph,
    });
  }

  return embed;
}

/** Claim/Close row. `claimedBy` null means nobody has it yet. */
function ticketButtons(claimedBy) {
  return new ActionRowBuilder().addComponents(
    claimedBy
      ? new ButtonBuilder()
          .setCustomId('ticket:unclaim')
          .setLabel('Unclaim')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('↩️')
      : new ButtonBuilder()
          .setCustomId('ticket:claim')
          .setLabel('Claim')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🙋'),
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒')
  );
}

/**
 * Make the channel, write the row, post the opening message.
 * Throws if Discord refuses; the caller reports that to the user.
 */
async function createTicket({ guild, opener, type, answers = {} }) {
  const number = db.nextTicketNumber(guild.id);
  const name = channelNameFor(number, 'normal');

  // Passed straight through rather than checked against the cache first: a
  // categoryId that is wrong should fail loudly here, not quietly create the
  // ticket loose at the top of the server where nobody is looking.
  const parent = type?.categoryId ?? null;

  const subject = answers[(type?.questions ?? [])[0]?.id] ?? null;

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent,
    topic: `Ticket #${pad(number)} · ${type?.label ?? 'Ticket'} · opened by ${opener.tag ?? opener.username}`,
    permissionOverwrites: overwritesFor(guild, opener.id, type),
    reason: `Ticket opened by ${opener.tag ?? opener.username}`,
  });

  const ticket = db.createTicket({
    guildId: guild.id,
    channelId: channel.id,
    channelName: name,
    openerId: opener.id,
    number,
    typeKey: type?.key ?? null,
    subject,
    priority: 'normal',
  });

  const pings = [`<@${opener.id}>`, ...(type?.pingRoleIds ?? []).map((id) => `<@&${id}>`)];

  const opening = await channel.send({
    content: pings.join(' '),
    embeds: [openingEmbed(ticket, type, opener, answers)],
    components: [ticketButtons(null)],
  });
  await opening.pin().catch(() => {});

  return { channel, ticket };
}

// ---------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------

/**
 * Repaint the pinned opening message so the buttons match reality. Best
 * effort: a ticket whose opening message was deleted still works fine
 * through /ticket, so a failure here is never worth surfacing.
 */
/**
 * Repaint the pinned message so its header and buttons match the database.
 *
 * Best effort throughout: a ticket whose pinned message was deleted still
 * works fine through /ticket, so a failure here is never worth surfacing.
 */
async function refreshPin(channel, ticket) {
  try {
    // fetchPins() replaced fetchPinned() partway through discord.js v14, and
    // package.json accepts either side of that line.
    const pins = channel.messages.fetchPins
      ? (await channel.messages.fetchPins()).items.map((p) => p.message)
      : [...(await channel.messages.fetchPinned()).values()];

    const mine = pins.find((m) => m.author.id === channel.client.user.id && m.components?.length);
    if (!mine) return;

    const payload = { components: [ticketButtons(ticket.claimed_by)] };

    const existing = mine.embeds?.[0];
    if (existing) {
      // Rebuild the two header fields in place and leave the answers alone —
      // they are the only copy of what the person originally typed.
      const answers = (existing.fields ?? []).filter(
        (f) => f.name !== F_STATUS && f.name !== F_PRIORITY
      );
      payload.embeds = [
        EmbedBuilder.from(existing)
          .setColor(accentFor(ticket, typeByKey(ticket.type_key)))
          .setFields([...headerFields(ticket), ...answers]),
      ];
    }

    await mine.edit(payload);
  } catch {
    /* the pin is a convenience, not the source of truth */
  }
}

async function claim(channel, ticket, member) {
  db.setClaim(channel.id, member.id);
  await refreshPin(channel, db.getTicket(channel.id));
  await channel.send({
    embeds: [notice(config.colors.ready, `${nameOf(member)} claimed this ticket`, avatarOf(member))],
  });
}

async function unclaim(channel, ticket) {
  db.clearClaim(channel.id);
  await refreshPin(channel, db.getTicket(channel.id));
  await channel.send({
    embeds: [notice(config.colors.neutral, 'Unclaimed — back up for grabs')],
  });
}

async function transfer(channel, ticket, target, actor) {
  db.setClaim(channel.id, target.id);
  db.addAudit(channel.guildId, actor.id, target.id, 'ticket_transfer', `#${pad(ticket.number)}`);
  await refreshPin(channel, db.getTicket(channel.id));
  await channel.send({
    content: `<@${target.id}>`,
    embeds: [
      notice(
        config.colors.neutral,
        `${nameOf(actor)} handed this ticket to ${nameOf(target)}`,
        avatarOf(target)
      ),
    ],
  });
}

// ---------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------

/**
 * The rank to pull in: one step above whoever is escalating. Someone with no
 * ladder rank at all escalates to the rank that runs reviews, which is the
 * lowest rung that is meaningfully "senior" in this bot's model.
 */
function escalationTarget(actor) {
  const idx = R.memberRankIndex(actor);
  if (idx < 0) return R.rankByKey(config.permissions.review) ?? R.ranks[R.ranks.length - 1];
  return R.ranks[Math.min(idx + 1, R.ranks.length - 1)];
}

async function escalate(channel, ticket, actor, reason) {
  const rank = escalationTarget(actor);

  if (T().escalationCategoryId && channel.parentId !== T().escalationCategoryId) {
    // lockPermissions:false — the ticket's own overwrites are the point of it
    // being private, and syncing to the category would throw them away.
    await channel
      .setParent(T().escalationCategoryId, { lockPermissions: false, reason: 'Ticket escalated' })
      .catch((e) => console.error('[tickets] could not move escalated channel:', e.message));
  }

  if (rank?.roleId && channel.guild.roles.cache.has(rank.roleId)) {
    await channel.permissionOverwrites
      .edit(rank.roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      })
      .catch(() => {});
  }

  db.markEscalated(channel.id, actor.id);
  await refreshPin(channel, db.getTicket(channel.id));
  db.addAudit(channel.guildId, actor.id, ticket.opener_id ?? actor.id, 'ticket_escalate', `#${pad(ticket.number)}`);

  const embed = new EmbedBuilder()
    .setColor(config.colors.borderline)
    .setAuthor({ name: `Escalated by ${nameOf(actor)}`, iconURL: avatarOf(actor) })
    .setTitle('⚠️  Needs a more senior look')
    .setDescription(
      `This has been passed up to **${rank?.name ?? 'senior staff'}**.` +
        (reason ? `\n\n>>> ${reason}` : '')
    )
    .setTimestamp();

  await channel.send({
    content: rank?.roleId ? `<@&${rank.roleId}>` : undefined,
    embeds: [embed],
  });

  return rank;
}

// ---------------------------------------------------------------
// Participants, priority, renaming
// ---------------------------------------------------------------

async function addUser(channel, member) {
  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
  });
  await channel.send({
    content: `<@${member.id}>`,
    embeds: [notice(config.colors.neutral, `${nameOf(member)} was added to this ticket`, avatarOf(member))],
  });
}

async function removeUser(channel, member) {
  await channel.permissionOverwrites.delete(member.id, 'Removed from ticket');
  await channel.send({
    embeds: [notice(config.colors.neutral, `${nameOf(member)} was removed from this ticket`, avatarOf(member))],
  });
}

/**
 * Discord rate-limits channel renames hard (roughly twice per ten minutes),
 * and priority is the kind of thing that gets flipped a few times in a row
 * on a busy ticket. So the database is updated first and unconditionally —
 * the name catching up late is cosmetic, the stored priority is not.
 */
async function setPriority(channel, ticket, priority) {
  db.setTicketPriority(channel.id, priority);

  const name = channelNameFor(ticket.number, priority);
  let renamed = true;
  try {
    await channel.setName(name, `Priority set to ${priority}`);
    db.setTicketChannelName(channel.id, name);
  } catch {
    renamed = false;
  }

  await refreshPin(channel, db.getTicket(channel.id));

  const p = PRIORITIES[priority];
  await channel.send({ embeds: [notice(p.color, `${p.emoji}  Priority set to ${p.label}`)] });

  return renamed;
}

async function rename(channel, ticket, rawName) {
  const clean = String(rawName)
    .toLowerCase()
    .replace(/[^a-z0-9\- ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  if (!clean) throw new Error('That name has no usable characters in it.');

  const p = PRIORITIES[ticket.priority] ?? PRIORITIES.normal;
  const name = `${p.prefix}${pad(ticket.number)}-${clean}`.slice(0, 100);

  await channel.setName(name, 'Ticket renamed');
  db.setTicketChannelName(channel.id, name);
  return name;
}

// ---------------------------------------------------------------
// Closing
// ---------------------------------------------------------------

function closingEmbed(guild, ticket, credited, closer, reason) {
  const type = typeByKey(ticket.type_key);
  const mins = Math.max(0, Math.round((Date.now() - ticket.opened_at) / 60000));
  const duration =
    mins < 60 ? `${mins} min` : mins < 1440 ? `${(mins / 60).toFixed(1)} h` : `${(mins / 1440).toFixed(1)} d`;

  const embed = new EmbedBuilder()
    .setColor(type?.color ?? config.colors.neutral)
    .setAuthor({
      name: closer ? `Closed by ${nameOf(closer)}` : 'Closed automatically',
      iconURL: avatarOf(closer),
    })
    .setTitle(`🔒  ${type?.label ?? ticket.type_key ?? 'Ticket'} · #${pad(ticket.number)}`)
    .addFields(
      { name: 'Opened by', value: ticket.opener_id ? `<@${ticket.opener_id}>` : 'unknown', inline: true },
      {
        name: 'Credited',
        value: credited.length ? credited.map((id) => `<@${id}>`).join(', ') : '— nobody',
        inline: true,
      },
      { name: 'Open for', value: duration, inline: true }
    )
    .setTimestamp();

  if (ticket.subject) embed.setDescription(`>>> ${ticket.subject.slice(0, 300)}`);

  // The wait the person actually experienced, which is the number the
  // responseSpeed metric is built on — worth seeing next to the credit.
  if (ticket.first_response_at) {
    const wait = Math.max(0, Math.round((ticket.first_response_at - ticket.opened_at) / 60000));
    embed.addFields({
      name: 'First reply',
      value: wait < 1 ? 'under a minute' : `${wait} min`,
      inline: true,
    });
  }

  embed.addFields({
    name: 'Claimed',
    value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'never claimed',
    inline: true,
  });

  if (reason) embed.addFields({ name: 'Resolution', value: `>>> ${reason}`.slice(0, 1024) });

  return embed;
}

async function postTranscript(guild, channel, ticket, credited, closer, reason) {
  const id = T().logChannelId;
  if (!id) return false;

  const log = await guild.channels.fetch(id).catch(() => null);
  if (!log?.isTextBased()) {
    console.error('[tickets] logChannelId is not a text channel I can post in');
    return false;
  }

  const payload = { embeds: [closingEmbed(guild, ticket, credited, closer, reason)] };

  try {
    payload.files = [await transcript.build(channel, ticket)];
  } catch (e) {
    // A missing transcript must never stop the ticket from closing — the
    // metrics are already written and the channel is about to be deleted.
    console.error('[tickets] transcript failed:', e.message);
    payload.embeds[0].addFields({
      name: 'Transcript',
      value: `Could not be generated: ${String(e.message).slice(0, 200)}`,
    });
  }

  await log.send(payload).catch((e) => console.error('[tickets] could not post transcript:', e.message));
  return true;
}

/**
 * Credit, transcript, then get rid of the channel.
 *
 * Order matters: the database is settled first, so a crash halfway through
 * loses a transcript rather than a staff member's ticket count.
 */
async function close({ channel, ticket, closer, reason, deleteChannel = true }) {
  const guild = channel.guild;

  const credited = decideCredit(guild.id, ticket, {
    minMessagesToCredit: T().minMessagesToCredit ?? 3,
    creditEveryone: T().creditEveryone ?? false,
  });
  for (const userId of credited) db.bumpMetric(guild.id, userId, 'ticketsHandled');

  db.closeTicket(channel.id, credited[0] ?? null);
  db.setCloseMeta(channel.id, closer?.id ?? null, reason ?? null);

  // Re-read rather than reusing the row we were handed: the transcript header
  // prints credited_to, which was only just written a line ago.
  await postTranscript(guild, channel, db.getTicket(channel.id) ?? ticket, credited, closer, reason);

  const delay = T().deleteDelaySeconds;

  if (!deleteChannel || delay === null || delay === undefined) {
    // Keep the channel: lock it so the conversation stops but stays readable.
    await channel.permissionOverwrites
      .edit(guild.roles.everyone.id, { SendMessages: false })
      .catch(() => {});
    if (ticket.opener_id) {
      await channel.permissionOverwrites
        .edit(ticket.opener_id, { SendMessages: false })
        .catch(() => {});
    }
    await channel.send({ embeds: [closingEmbed(guild, ticket, credited, closer, reason)] }).catch(() => {});
    return { credited, deleted: false };
  }

  await channel
    .send({
      embeds: [
        closingEmbed(guild, ticket, credited, closer, reason).setFooter({
          text: `This channel disappears in ${delay} seconds.`,
        }),
      ],
    })
    .catch(() => {});

  setTimeout(() => {
    channel.delete('Ticket closed').catch((e) => {
      console.error('[tickets] could not delete closed channel:', e.message);
    });
  }, delay * 1000).unref();

  return { credited, deleted: true };
}

// ---------------------------------------------------------------
// Blacklist
// ---------------------------------------------------------------

/**
 * The database row is the gate; the role is only there so a human scrolling
 * the member list can see who is blocked. So a role that will not apply is
 * reported as a warning, never as a failure — the block itself already holds.
 */
async function applyBlacklistRole(member, add) {
  const roleId = T().blacklistRoleId;
  if (!roleId || !member) return null;
  if (!member.guild.roles.cache.has(roleId)) {
    return 'tickets.blacklistRoleId is not a role in this server, so no role was applied.';
  }
  try {
    if (add) await member.roles.add(roleId, 'Ticket blacklist');
    else await member.roles.remove(roleId, 'Ticket blacklist lifted');
    return null;
  } catch (e) {
    return `The block is in place, but the role could not be changed: ${e.message}`;
  }
}

// ---------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------

/**
 * A ticket channel someone deleted by hand still has to be settled, or the
 * row sits open forever and the person who worked it never gets paid.
 */
function settleDeleted(guildId, ticket) {
  const credited = decideCredit(guildId, ticket, {
    minMessagesToCredit: T().minMessagesToCredit ?? 3,
    creditEveryone: T().creditEveryone ?? false,
  });
  for (const userId of credited) db.bumpMetric(guildId, userId, 'ticketsHandled');
  db.closeTicket(ticket.channel_id, credited[0] ?? null);
  return credited;
}

/** Tickets whose channel vanished while the bot was off. */
async function reconcile(client) {
  if (!T().enabled) return;
  let settled = 0;

  for (const guild of client.guilds.cache.values()) {
    for (const ticket of db.listOpenNativeTickets(guild.id)) {
      const exists = await guild.channels.fetch(ticket.channel_id).catch(() => null);
      if (exists) continue;
      settleDeleted(guild.id, ticket);
      settled++;
    }
  }

  const anyGuild = client.guilds.cache.first();
  const open = anyGuild ? db.listOpenNativeTickets(anyGuild.id).length : 0;
  console.log(
    `[tickets] native system on · ${open} open` +
      (settled ? ` · settled ${settled} closed while offline` : '')
  );
}

function register(client) {
  if (!T().enabled) {
    console.log('[tickets] native ticket system is off');
    return;
  }

  client.on(Events.ChannelDelete, (channel) => {
    try {
      const ticket = db.getTicket(channel.id);
      if (!ticket || ticket.source !== 'native' || ticket.state !== 'open') return;
      const credited = settleDeleted(channel.guildId ?? channel.guild?.id, ticket);
      console.log(
        `[tickets] #${channel.name} deleted by hand · credited ${credited.join(', ') || 'nobody'}`
      );
    } catch (e) {
      console.error('[tickets] channel delete:', e.message);
    }
  });

  client.once(Events.ClientReady, (c) => {
    reconcile(c).catch((e) => console.error('[tickets] reconcile failed:', e));
  });
}

module.exports = {
  PRIORITIES,
  T,
  register,
  handleMessage,
  decideCredit,
  typeByKey,
  ticketCategoryIds,
  isTicketStaff,
  isCustomEmoji,
  claimReleaseBlocked,
  overwritesFor,
  audienceFor,
  channelNameFor,
  pad,
  openBlockedReason,
  createTicket,
  ticketButtons,
  refreshPin,
  headerFields,
  accentFor,
  claim,
  unclaim,
  transfer,
  escalate,
  escalationTarget,
  addUser,
  removeUser,
  setPriority,
  rename,
  close,
  applyBlacklistRole,
  settleDeleted,
};

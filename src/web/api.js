const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const tickets = require('../tickets');
const ticketPanel = require('../ticketPanel');
const standing = require('../standing');
const team = require('../team');
const adjustments = require('../adjustments');
const { computeScore, summariseVouches, verdict } = require('../scoring');
const { buildMovement } = require('../movement');
const { logAction, announce, tryDM } = require('../util');

/**
 * The dashboard's JSON API.
 *
 * Everything here reuses the same modules the slash commands do — scoring,
 * standing, ranks, the ticket service — so a number on the website and the
 * same number in an embed cannot disagree. Nothing recalculates anything.
 */

const DAY = 86400000;

const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};

function guildOf(client) {
  const id = process.env.GUILD_ID;
  const guild = (id && client?.guilds?.cache?.get(id)) || client?.guilds?.cache?.first();
  if (!guild) fail(503, 'The bot is not connected to a server yet. Give it a moment.');
  return guild;
}

/**
 * Who the dashboard acts as.
 *
 * There is no login per person — reaching the page at all means shell access to
 * the box, which is already above every rank in this system. Actions are
 * attributed to the server owner so the audit trail names a real accountable
 * human rather than the bot itself.
 */
async function actorOf(guild) {
  const id = process.env.USER_ID || guild.ownerId;
  const member = await guild.members.fetch(id).catch(() => null);
  if (!member) fail(503, 'Could not resolve who the dashboard is acting as. Set USER_ID in .env.');
  return member;
}

const trialStates = ['active', 'midpoint_posted', 'awaiting_review'];
const onTrial = (row) => trialStates.includes(row?.trial_state ?? '');

// ---------------------------------------------------------------
// Reading
// ---------------------------------------------------------------

/** Display info for a user id, falling back to the raw id when they have left. */
async function person(guild, userId) {
  const m = await guild.members.fetch(userId).catch(() => null);
  return {
    id: userId,
    name: m?.displayName ?? m?.user?.username ?? userId,
    tag: m?.user?.tag ?? null,
    avatar: m?.displayAvatarURL?.({ size: 64, extension: 'png' }) ?? null,
    inServer: Boolean(m),
  };
}

async function staffList(guild) {
  const rows = db.listStaff(guild.id);
  const out = [];

  for (const row of rows) {
    const trial = onTrial(row);
    const windowDays = trial
      ? Math.max(1, Math.round((Date.now() - row.trial_started_at) / DAY))
      : standing.windowDaysFor(row.rank_key);
    const to = Date.now();
    const from = trial ? row.trial_started_at : to - windowDays * DAY;

    const metrics = db.getMetrics(guild.id, row.user_id, from, to);
    const profile = trial ? null : standing.scaledProfile(row.rank_key, windowDays);
    const { score } = computeScore(metrics, profile);
    const adjusted = adjustments.apply(score, guild.id, row.user_id);

    out.push({
      ...(await person(guild, row.user_id)),
      rankKey: row.rank_key,
      rankName: R.rankByKey(row.rank_key)?.name ?? row.rank_key,
      rankIndex: R.indexOfKey(row.rank_key),
      hiredAt: row.hired_at,
      rankSince: row.rank_since,
      onTrial: trial,
      trialState: row.trial_state,
      trialEndsAt: row.trial_ends_at,
      score: Math.round(adjusted.score),
      onLoa: Boolean(db.activeLoa(guild.id, row.user_id)),
    });
  }

  out.sort((a, b) => b.rankIndex - a.rankIndex || b.score - a.score);
  return out;
}

async function ticketList(guild) {
  const open = db.listOpenNativeTickets(guild.id);
  const out = [];

  for (const t of open) {
    const participants = db.getParticipants(t.channel_id);
    out.push({
      channelId: t.channel_id,
      number: t.number,
      name: t.channel_name,
      type: t.type_key,
      typeLabel: tickets.typeByKey(t.type_key)?.label ?? t.type_key,
      subject: t.subject,
      priority: t.priority ?? 'normal',
      openedAt: t.opened_at,
      lastActivityAt: t.last_activity_at,
      escalatedAt: t.escalated_at,
      opener: t.opener_id ? await person(guild, t.opener_id) : null,
      claimedBy: t.claimed_by ? await person(guild, t.claimed_by) : null,
      firstResponseAt: t.first_response_at,
      messages: participants.reduce((n, p) => n + p.messages, 0),
    });
  }

  // Unclaimed first, then oldest — the order you actually want to work them in.
  out.sort((a, b) => (a.claimedBy ? 1 : 0) - (b.claimedBy ? 1 : 0) || a.openedAt - b.openedAt);
  return out;
}

async function overview(client, guild) {
  const staff = db.listStaff(guild.id);
  const open = db.listOpenNativeTickets(guild.id);
  const trials = db.listTrials(guild.id);

  const soon = trials.filter((t) => t.trial_ends_at && t.trial_ends_at - Date.now() < 3 * DAY);
  const unclaimed = open.filter((t) => !t.claimed_by);

  const closedToday = db.db
    .prepare(
      `SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND state = 'closed' AND closed_at > ?`
    )
    .get(guild.id, Date.now() - DAY).n;

  return {
    bot: {
      tag: client?.user?.tag ?? null,
      ready: Boolean(client?.isReady?.()),
      uptimeSeconds: Math.round(process.uptime()),
      guild: guild.name,
      members: guild.memberCount ?? null,
    },
    counts: {
      staff: staff.length,
      trials: trials.length,
      trialsEndingSoon: soon.length,
      openTickets: open.length,
      unclaimedTickets: unclaimed.length,
      closedTicketsToday: closedToday,
      blacklisted: db.listTicketBlacklist(guild.id).length,
      onLoa: db.listActiveLoa(guild.id).length,
    },
    ticketsEnabled: config.tickets?.enabled !== false,
    writes: config.web?.allowWrites !== false,
  };
}

async function staffDetail(guild, userId) {
  const row = db.getStaff(guild.id, userId);
  if (!row) fail(404, 'That person is not registered as staff.');

  const trial = onTrial(row);
  const to = Date.now();
  const windowDays = trial
    ? Math.max(1, Math.round((to - row.trial_started_at) / DAY))
    : standing.windowDaysFor(row.rank_key);
  const from = trial ? row.trial_started_at : to - windowDays * DAY;

  const metrics = db.getMetrics(guild.id, userId, from, to);
  const profile = trial ? null : standing.scaledProfile(row.rank_key, windowDays);
  const { score, breakdown } = computeScore(metrics, profile);

  const cycle = row.trial_started_at ?? 0;
  const vouches = db.getVouches(guild.id, userId, cycle);
  const vouchSummary = summariseVouches(vouches);

  let standingView = null;
  if (!trial && standing.enabled?.()) {
    try {
      standingView = standing.assess(guild.id, row);
    } catch (e) {
      standingView = { error: e.message };
    }
  }

  const ledger = adjustments.summarise(guild.id, userId);
  const applied = adjustments.apply(score, guild.id, userId);

  return {
    ...(await person(guild, userId)),
    rankKey: row.rank_key,
    rankName: R.rankByKey(row.rank_key)?.name ?? row.rank_key,
    rankIndex: R.indexOfKey(row.rank_key),
    hiredAt: row.hired_at,
    rankSince: row.rank_since,
    onTrial: trial,
    trialState: row.trial_state,
    trialStartedAt: row.trial_started_at,
    trialEndsAt: row.trial_ends_at,
    windowDays,
    score: Math.round(applied.score),
    rawScore: Math.round(score),
    adjustment: applied.delta,
    verdict: trial ? verdict(Math.round(applied.score), vouchSummary) : null,
    breakdown,
    metrics,
    vouches: await Promise.all(
      vouches.map(async (v) => ({
        ...(await person(guild, v.voucher_id)),
        verdict: v.verdict,
        reason: v.reason,
        createdAt: v.created_at,
      }))
    ),
    vouchSummary,
    standing: standingView,
    ledger,
    adjustments: db.allAdjustments(guild.id, userId, 25),
    notes: await Promise.all(
      db.getNotes(guild.id, userId, 25).map(async (n) => ({
        ...n,
        author: await person(guild, n.author_id),
      }))
    ),
    audit: db.getAudit(guild.id, userId, 25),
    loa: db.activeLoa(guild.id, userId),
    links: db.linksForUser(guild.id, userId),
    ticketStats: db.ticketStatsFor(guild.id, userId, from, to),
  };
}

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

function readOverrides() {
  const file = config.overridesPath;
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(500, `config.local.json is not valid JSON: ${e.message}`);
  }
}

function writeOverrides(next) {
  const file = config.overridesPath;
  if (!file) fail(500, 'No overrides path — is this an old config.js?');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Write beside the real file and rename over it. A half-written overrides
  // file that the bot then reads on boot is exactly the kind of thing that
  // takes a server down at 3am.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
}

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over ?? {})) {
    if (isPlain(v) && isPlain(base[k])) deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

/**
 * The settings the dashboard is willing to change.
 *
 * An allowlist rather than "anything goes": config.js holds regexes and scoring
 * weights whose failure modes are subtle and silent, and a typo in a form field
 * should not be able to switch off half the scoring system by accident. Editing
 * the file directly still does whatever you want.
 */
const EDITABLE = [
  'tickets.enabled',
  'tickets.staffRoleIds',
  'tickets.logChannelId',
  'tickets.escalationCategoryId',
  'tickets.blacklistRoleId',
  'tickets.maxOpenPerUser',
  'tickets.cooldownSeconds',
  'tickets.deleteDelaySeconds',
  'tickets.minMessagesToCredit',
  'tickets.creditEveryone',
  'tickets.panel',
  'tickets.types',
  'channels.reviews',
  'channels.staffLog',
  'channels.staffChannels',
  'channels.ignored',
  'staffTeamRoleId',
  'trial.defaultDays',
  'digest.enabled',
  'conduct.enabled',
  'conduct.onlyDuringTrial',
  'announcements.channelId',
  'announcements.onHire',
  'announcements.onPromote',
  'announcements.onDemote',
  'announcements.onRemove',
  'ticketKing.enabled',
  'web.allowWrites',
];

const editable = (dotted) =>
  EDITABLE.some((allowed) => dotted === allowed || dotted.startsWith(allowed + '.'));

function setPath(target, dotted, value) {
  const parts = dotted.split('.');
  const last = parts.pop();
  let node = target;
  for (const p of parts) {
    if (!isPlain(node[p])) node[p] = {};
    node = node[p];
  }
  node[last] = value;
}

function getPath(source, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), source);
}

function configView() {
  const overrides = readOverrides();
  return {
    overridesPath: config.overridesPath,
    editable: EDITABLE,
    values: Object.fromEntries(EDITABLE.map((k) => [k, getPath(config, k) ?? null])),
    overridden: EDITABLE.filter((k) => getPath(overrides, k) !== undefined),
    ranks: R.ranks,
    ticketTypes: config.tickets?.types ?? [],
  };
}

function saveConfig(changes) {
  if (!isPlain(changes) || !Object.keys(changes).length) {
    fail(400, 'Nothing to save.');
  }

  for (const key of Object.keys(changes)) {
    if (!editable(key)) fail(403, `${key} is not editable from the dashboard.`);
  }

  const overrides = readOverrides();
  for (const [key, value] of Object.entries(changes)) setPath(overrides, key, value);
  writeOverrides(overrides);

  // Merge into the live object so anything that reads config at call time
  // picks it up now. Modules that cached a value at require() time will not,
  // which is why the UI says a restart is the safe move.
  for (const [key, value] of Object.entries(changes)) setPath(config, key, value);

  return { saved: Object.keys(changes), overridesPath: config.overridesPath };
}

function resetConfig(key) {
  if (!editable(key)) fail(403, `${key} is not editable from the dashboard.`);

  const overrides = readOverrides();
  const parts = key.split('.');
  const last = parts.pop();
  let node = overrides;
  for (const p of parts) {
    if (!isPlain(node[p])) return { reset: key, note: 'It was not overridden.' };
    node = node[p];
  }
  delete node[last];
  writeOverrides(overrides);

  return { reset: key, note: 'Restart to load the value from config.js again.' };
}

// ---------------------------------------------------------------
// Writing — staff
// ---------------------------------------------------------------

async function changeRank(client, guild, userId, { destinationKey, reason, note, remove, kind }) {
  if (!reason || reason.trim().length < 3) fail(400, 'A reason is required.');

  const actor = await actorOf(guild);
  const target = await guild.members.fetch(userId).catch(() => null);
  if (!target) fail(404, 'That user is not in the server.');
  if (target.user.bot) fail(400, 'Bots do not get ranks.');

  const currentIdx = R.memberRankIndex(target);
  const destIdx = remove ? -1 : R.indexOfKey(destinationKey);
  if (!remove && destIdx === -1) fail(400, 'That is not a rank.');

  const blocked = R.checkActionAllowed(actor, target, remove ? null : destIdx);
  if (blocked) fail(403, blocked);

  try {
    await R.applyRank(target, destIdx, `${kind} via dashboard: ${reason}`);
  } catch (e) {
    fail(
      500,
      `Discord refused the role change: ${e.message}. Usually the bot's role is not above the rank roles in Server Settings > Roles.`
    );
  }

  const from = currentIdx >= 0 ? R.ranks[currentIdx].name : 'not staff';
  const to = destIdx >= 0 ? R.ranks[destIdx] : null;

  if (to) {
    db.setRank(guild.id, userId, to.key, actor.id);
    const row = db.getStaff(guild.id, userId);
    if (onTrial(row)) db.clearTrial(guild.id, userId, kind === 'promote' ? 'passed' : 'failed');
  } else {
    db.removeStaff(guild.id, userId);
  }

  db.addAudit(guild.id, actor.id, userId, kind, `${from} → ${to?.name ?? 'removed'}: ${reason}`);

  const color = kind === 'promote' ? config.colors.promote : config.colors.demote;

  await logAction(
    guild,
    new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: `${target.user.username} ${kind}d`, iconURL: target.user.displayAvatarURL() })
      .setDescription(`**${from}** → **${to?.name ?? 'removed from the team'}**`)
      .addFields(
        { name: 'Reason', value: reason },
        { name: 'By', value: `<@${actor.id}> _(dashboard)_`, inline: true },
        { name: 'User', value: `<@${userId}>`, inline: true }
      )
      .setTimestamp()
  );

  const announceKey = to ? (kind === 'promote' ? 'onPromote' : 'onDemote') : 'onRemove';
  if (config.announcements?.[announceKey]) {
    await announce(
      guild,
      buildMovement({
        guild,
        userId,
        username: target.user.username,
        avatarURL: target.user.displayAvatarURL(),
        fromRank: currentIdx >= 0 ? R.ranks[currentIdx] : null,
        toRank: to,
        note,
        kind: to ? kind : 'remove',
        color,
      })
    );
  }

  await tryDM(target.user, {
    embeds: [
      new EmbedBuilder()
        .setColor(color)
        .setTitle(`Your rank changed in ${guild.name}`)
        .setDescription(`**${from}** → **${to?.name ?? 'removed from the team'}**\n\n${reason}`),
    ],
  });

  return { from, to: to?.name ?? null };
}

// ---------------------------------------------------------------
// Routing
// ---------------------------------------------------------------

async function route({ client, method, path: p, query, body }) {
  const guild = guildOf(client);
  const seg = p.split('/').filter(Boolean);

  // ---- GET ----
  if (method === 'GET') {
    if (p === '/overview') return await overview(client, guild);
    if (p === '/staff') return { staff: await staffList(guild) };
    if (seg[0] === 'staff' && seg[1]) return await staffDetail(guild, seg[1]);
    if (p === '/tickets') return { tickets: await ticketList(guild) };

    if (p === '/blacklist') {
      return {
        blacklist: await Promise.all(
          db.listTicketBlacklist(guild.id).map(async (b) => ({
            ...(await person(guild, b.user_id)),
            reason: b.reason,
            createdAt: b.created_at,
            by: await person(guild, b.author_id),
          }))
        ),
      };
    }

    if (p === '/leaderboard') {
      const days = Math.min(365, Math.max(1, Number(query.get('days')) || 30));
      const to = Date.now();
      const rows = team.leaderboard(guild.id, to - days * DAY, to);
      return {
        days,
        rows: await Promise.all(
          rows.map(async (r) => ({ ...r, ...(await person(guild, r.userId)) }))
        ),
      };
    }

    if (p === '/config') return configView();

    if (p === '/roles') {
      return {
        roles: [...guild.roles.cache.values()]
          .filter((r) => r.id !== guild.id)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
      };
    }

    if (p === '/channels') {
      return {
        channels: [...guild.channels.cache.values()]
          .map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }

    return undefined;
  }

  // ---- writes ----
  if (method === 'POST' || method === 'DELETE') {
    if (p === '/config') return saveConfig(body.changes);
    if (p === '/config/reset') return resetConfig(String(body.key ?? ''));

    if (p === '/restart') {
      // systemd (and start.bat's loop, and Render) bring it straight back.
      // Nothing is lost: SQLite is committed on every write.
      setTimeout(() => process.exit(0), 250).unref();
      return { restarting: true };
    }

    if (p === '/panel') {
      const channel = await guild.channels.fetch(String(body.channelId ?? '')).catch(() => null);
      if (!channel?.isTextBased()) fail(400, 'That is not a text channel I can post in.');
      await channel.send(ticketPanel.buildPanel(guild));
      return { posted: channel.name };
    }

    // ---- staff ----
    if (seg[0] === 'staff' && seg[1] && seg[2]) {
      const userId = seg[1];
      const action = seg[2];

      if (action === 'promote' || action === 'demote') {
        return await changeRank(client, guild, userId, {
          destinationKey: body.rank,
          reason: body.reason,
          note: body.note,
          remove: action === 'demote' && Boolean(body.remove),
          kind: action,
        });
      }

      if (action === 'note') {
        const kind = ['praise', 'concern', 'neutral'].includes(body.kind) ? body.kind : 'neutral';
        if (!body.body?.trim()) fail(400, 'The note is empty.');
        const actor = await actorOf(guild);
        db.addNote(guild.id, userId, actor.id, kind, String(body.body).slice(0, 1000));
        return { ok: true };
      }

      if (action === 'vouch') {
        const v = String(body.verdict ?? '');
        if (!['yes', 'no', 'abstain'].includes(v)) fail(400, 'Verdict must be yes, no or abstain.');
        const row = db.getStaff(guild.id, userId);
        if (!row) fail(404, 'Not a staff member.');
        const actor = await actorOf(guild);
        db.putVouch(guild.id, userId, actor.id, row.trial_started_at ?? 0, v, body.reason ?? null);
        return { ok: true };
      }

      if (action === 'trial') {
        const row = db.getStaff(guild.id, userId);
        if (!row) fail(404, 'Not a staff member.');
        const days = Math.min(90, Math.max(1, Number(body.days) || config.trial.defaultDays || 14));

        if (body.op === 'start') {
          db.startTrial(guild.id, userId, Date.now() + days * DAY);
          return { ok: true, endsAt: Date.now() + days * DAY };
        }
        if (body.op === 'extend') {
          const base = row.trial_ends_at ?? Date.now();
          db.setTrialEnd(guild.id, userId, base + days * DAY);
          return { ok: true, endsAt: base + days * DAY };
        }
        if (body.op === 'end') {
          db.setTrialState(guild.id, userId, 'awaiting_review');
          return { ok: true };
        }
        fail(400, 'op must be start, extend or end.');
      }

      if (action === 'adjust') {
        const points = Number(body.points);
        const check = adjustments.validate(points, body.reason);
        if (check) fail(400, check);
        const actor = await actorOf(guild);

        db.addAdjustment({
          guildId: guild.id,
          userId,
          points,
          reason: String(body.reason).slice(0, 300),
          authorId: actor.id,
          expiresAt: adjustments.expiryFor(Number(body.days) || null),
        });
        return { ok: true };
      }

      return undefined;
    }

    // ---- tickets ----
    if (seg[0] === 'tickets' && seg[1] && seg[2]) {
      const channelId = seg[1];
      const action = seg[2];

      const ticket = db.getTicket(channelId);
      if (!ticket || ticket.state !== 'open') fail(404, 'That ticket is not open.');

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) fail(404, 'That ticket channel is gone. Restart to settle it.');

      if (action === 'claim') {
        const who = await guild.members.fetch(String(body.userId ?? '')).catch(() => null);
        if (!who) fail(400, 'Pick a staff member to claim it for.');
        if (!tickets.isTicketStaff(who)) fail(400, `${who.displayName} is not ticket staff.`);
        await tickets.claim(channel, ticket, who);
        return { ok: true };
      }

      if (action === 'unclaim') {
        await tickets.unclaim(channel, ticket);
        return { ok: true };
      }

      if (action === 'priority') {
        const level = String(body.level ?? '');
        if (!tickets.PRIORITIES[level]) fail(400, 'Unknown priority.');
        const renamed = await tickets.setPriority(channel, ticket, level);
        return { ok: true, renamed };
      }

      if (action === 'close') {
        const actor = await actorOf(guild);
        const { credited } = await tickets.close({
          channel,
          ticket,
          closer: actor.user,
          reason: body.reason ? String(body.reason).slice(0, 500) : null,
        });
        return { ok: true, credited };
      }

      return undefined;
    }

    // ---- blacklist ----
    if (p === '/blacklist' && method === 'POST') {
      const userId = String(body.userId ?? '');
      if (!/^\d{15,20}$/.test(userId)) fail(400, 'That is not a Discord user ID.');
      if (db.isTicketBlacklisted(guild.id, userId)) fail(400, 'Already blocked.');

      const actor = await actorOf(guild);
      db.addTicketBlacklist(guild.id, userId, body.reason ?? null, actor.id);
      db.addAudit(guild.id, actor.id, userId, 'ticket_blacklist', body.reason ?? null);

      const member = await guild.members.fetch(userId).catch(() => null);
      const warning = await tickets.applyBlacklistRole(member, true);
      return { ok: true, warning };
    }

    if (seg[0] === 'blacklist' && seg[1] && method === 'DELETE') {
      const userId = seg[1];
      if (!db.removeTicketBlacklist(guild.id, userId)) fail(404, 'They were not blocked.');

      const actor = await actorOf(guild);
      db.addAudit(guild.id, actor.id, userId, 'ticket_unblacklist', null);
      const member = await guild.members.fetch(userId).catch(() => null);
      const warning = await tickets.applyBlacklistRole(member, false);
      return { ok: true, warning };
    }
  }

  return undefined;
}

module.exports = { route, EDITABLE };

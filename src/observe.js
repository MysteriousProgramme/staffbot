const config = require('../config');
const db = require('./db');

/**
 * Watches how staff behave across the whole server, not just where they post.
 *
 * Two things, deliberately separate:
 *
 *   PRESENCE  — one row per person/day/channel/hour. No content, ever. Feeds
 *               "channel spread" (are they present across the server or only
 *               in one corner?) and the coverage histogram on the review card.
 *
 *   CONDUCT   — a small rolling sample of what a trial member actually said,
 *               so a human can read their tone before deciding. This DOES
 *               store message content, which is why it is limited to people
 *               on trial, capped at a few dozen lines, and auto-purged.
 *
 * The numbers tell you whether someone showed up. Only the words tell you
 * whether you want them representing your server.
 */

const CD = () => config.conduct;

function isOnTrial(guildId, userId) {
  const row = db.getStaff(guildId, userId);
  return Boolean(
    row?.trial_state && ['active', 'midpoint_posted', 'awaiting_review'].includes(row.trial_state)
  );
}

/**
 * Record that this person was present here, now.
 * Called for EVERY channel a staff member speaks in, including staff channels
 * and ignored ones — presence is about where they are, and an ignored channel
 * still proves they were around. Only the scored message metrics respect the
 * ignore list.
 */
function notePresence(guildId, userId, channelId, ts) {
  try {
    db.bumpPresence(guildId, userId, channelId, ts);
  } catch (e) {
    console.error('[observe] presence:', e.message);
  }
}

/**
 * Store a line for the conduct sample, if this person qualifies.
 * @param source 'discord' | 'minecraft'
 */
function noteConduct(guildId, userId, channelId, content, source = 'discord') {
  const c = CD();
  if (!c?.enabled) return;
  if (c.onlyDuringTrial && !isOnTrial(guildId, userId)) return;
  if ((c.excludeChannelIds ?? []).includes(String(channelId))) return;

  const text = String(content ?? '').trim();
  if (!text) return;
  if (text.length < (config.tracking?.minMessageLength ?? 5)) return;

  try {
    db.addConduct(
      guildId,
      userId,
      channelId,
      source,
      text.slice(0, c.maxLength ?? 220),
      c.sampleSize ?? 30
    );
  } catch (e) {
    console.error('[observe] conduct:', e.message);
  }
}

/**
 * Pick an evenly-spaced spread across the stored sample rather than the last
 * N. The last five messages are usually five lines of one conversation, which
 * reads as a single moment rather than a habit.
 */
function conductSample(guildId, userId, want = 6) {
  const rows = db.getConduct(guildId, userId, (CD()?.sampleSize ?? 30) * 2);
  if (rows.length <= want) return rows;

  const step = rows.length / want;
  const out = [];
  for (let i = 0; i < want; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

/** Simple 24-slot bar of when they are around, in UTC. */
function coverageBar(guildId, userId, from, to) {
  const rows = db.hourHistogram(guildId, userId, from, to);
  if (!rows.length) return null;

  const byHour = new Array(24).fill(0);
  for (const r of rows) byHour[r.hour] = r.n;
  const max = Math.max(...byHour);
  const blocks = ' ▁▂▃▄▅▆▇█';

  return byHour
    .map((n) => blocks[Math.min(8, Math.ceil((n / max) * 8))])
    .join('');
}

/** Delete anything past the retention window. Runs daily. */
function startPurge() {
  const days = CD()?.retentionDays ?? 45;
  if (!CD()?.enabled || !days) return;

  const run = () => {
    try {
      const removed = db.purgeConduct(Date.now() - days * 86400000);
      if (removed) console.log(`[observe] purged ${removed} conduct line(s) older than ${days}d`);
    } catch (e) {
      console.error('[observe] purge:', e.message);
    }
  };
  setTimeout(run, 30000);
  setInterval(run, 24 * 3600 * 1000).unref();
}

module.exports = { notePresence, noteConduct, conductSample, coverageBar, startPurge, isOnTrial };

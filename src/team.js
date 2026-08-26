const config = require('../config');
const db = require('./db');
const R = require('./ranks');
const { computeScore } = require('./scoring');
const standing = require('./standing');

/**
 * Whole-team views. Everything here reads data already being collected —
 * no new tracking, just questions nobody was asking of it.
 */

/**
 * Score every tracked staff member over a window, best first.
 *
 * Each person is scored against THEIR OWN rank's targets, not one shared set.
 * That sounds like it would make the column meaningless across ranks; it does
 * the opposite. 80 now means "80% of what this rank is for" for everyone on
 * the board, so a Head Mod is not flattered by a ticket target meant for a
 * trial, and a Staff member is not punished for not running the team.
 */
function leaderboard(guildId, from, to) {
  const rows = [];
  for (const staff of db.listStaff(guildId)) {
    const metrics = db.getMetrics(guildId, staff.user_id, from, to);
    const onTrial = ['active', 'midpoint_posted', 'awaiting_review'].includes(staff.trial_state ?? '');
    const windowDays = Math.max(1, Math.round((to - from) / 86400000));
    const profile = onTrial ? null : standing.scaledProfile(staff.rank_key, windowDays);
    const { score, breakdown } = computeScore(metrics, profile);
    const weakest = breakdown[0]; // computeScore sorts weakest first
    rows.push({
      userId: staff.user_id,
      rankKey: staff.rank_key,
      rankName: R.rankByKey(staff.rank_key)?.name ?? staff.rank_key,
      score,
      metrics,
      weakest,
      scoredAgainst: profile ? 'rank' : 'trial',
      onLoa: Boolean(db.activeLoa(guildId, staff.user_id)),
      onTrial: ['active', 'midpoint_posted', 'awaiting_review'].includes(staff.trial_state ?? ''),
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

/**
 * When is the team actually online, and when is nobody?
 * Returns 24 slots with how many distinct people were around in each.
 */
function coverage(guildId, from, to) {
  const rows = db.teamHourHistogram(guildId, from, to);
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, people: 0, messages: 0 }));
  for (const r of rows) {
    hours[r.hour].people = r.people;
    hours[r.hour].messages = r.messages;
  }

  const maxPeople = Math.max(1, ...hours.map((h) => h.people));
  const blocks = ' ▁▂▃▄▅▆▇█';
  const bar = hours.map((h) => blocks[Math.min(8, Math.ceil((h.people / maxPeople) * 8))]).join('');

  // A "gap" is an hour nobody was seen in at all.
  const gaps = [];
  let run = null;
  for (const h of hours) {
    if (h.people === 0) {
      if (!run) run = { start: h.hour, end: h.hour };
      else run.end = h.hour;
    } else if (run) {
      gaps.push(run);
      run = null;
    }
  }
  if (run) gaps.push(run);

  // A gap that wraps midnight reads as two, so stitch them back together.
  if (gaps.length > 1 && gaps[0].start === 0 && gaps[gaps.length - 1].end === 23) {
    const first = gaps.shift();
    gaps[gaps.length - 1].end = first.end + 24;
  }

  return { hours, bar, gaps, maxPeople };
}

const fmtGap = (g) => {
  const h = (n) => String(n % 24).padStart(2, '0') + ':00';
  const len = g.end - g.start + 1;
  return `${h(g.start)}–${h(g.end + 1)} (${len}h)`;
};

/** Staff who haven't been seen for a while, ignoring anyone on leave. */
function quiet(guildId, days) {
  const seen = db.lastSeen(guildId);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = [];

  for (const staff of db.listStaff(guildId)) {
    if (db.activeLoa(guildId, staff.user_id)) continue; // on leave, not missing
    const last = seen.get(staff.user_id) ?? null;
    if (!last || last < cutoff) {
      out.push({
        userId: staff.user_id,
        rankName: R.rankByKey(staff.rank_key)?.name ?? staff.rank_key,
        lastSeen: last,
        daysQuiet: last
          ? Math.round((Date.now() - Date.parse(last + 'T00:00:00Z')) / 86400000)
          : null,
      });
    }
  }
  return out.sort((a, b) => (b.daysQuiet ?? 999) - (a.daysQuiet ?? 999));
}

module.exports = { leaderboard, coverage, quiet, fmtGap };

const config = require('../config');
const db = require('./db');

/**
 * MANUAL POINTS — /deduct and /increase.
 *
 * The metrics cannot see everything. Talking a player out of quitting, writing
 * the rules page, training two new staff: none of it shows up in a ticket
 * count. And someone can hit every number while being sharp with members in a
 * way no metric catches.
 *
 * So a human can move the score. The danger is obvious — a hand-adjustable
 * score is not a measurement any more, it is an opinion wearing a number's
 * clothes. Three properties keep it honest, and they are enforced here rather
 * than left to good manners:
 *
 *   CAPPED    One adjustment is bounded, and the total swing in a window is
 *             bounded both ways. The down cap (25) is smaller than the gap
 *             between the hold bar and the promote bar (35), so adjustments
 *             can tip a borderline case but cannot manufacture one.
 *
 *   TEMPORARY An adjustment counts only while it falls inside the window
 *             being scored. It ages out of a rolling window on its own. A bad
 *             week should not follow somebody for a year; `/note kind:concern`
 *             is the tool for a lasting record.
 *
 *   VISIBLE   Every adjustment carries a required reason, an author and a
 *             timestamp, and is rendered on the card. There is no way to move
 *             somebody's score without your name being attached to it.
 */

const A = () => config.adjustments ?? {};
const enabled = () => A().enabled !== false;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** The largest single adjustment allowed, either direction. */
function maxSingle() {
  return Math.max(1, A().maxPerAdjustment ?? 15);
}

/**
 * Apply every live adjustment in a window to a raw score.
 * Returns the adjusted score plus everything the card needs to explain it.
 */
function applyTo(guildId, userId, rawScore, from, to) {
  const empty = { score: rawScore, raw: rawScore, delta: 0, rows: [], clampedUp: false, clampedDown: false };
  if (!enabled()) return empty;

  let rows;
  try {
    rows = db.adjustmentsIn(guildId, userId, from, to);
  } catch {
    return empty;
  }
  if (!rows.length) return empty;

  // Sum each direction separately, then cap each. Capping the net total
  // instead would let a +20 "pay for" a -20, which quietly undoes the point
  // of having a down cap at all.
  const rawUp = rows.filter((r) => r.points > 0).reduce((s, r) => s + r.points, 0);
  const rawDown = rows.filter((r) => r.points < 0).reduce((s, r) => s - r.points, 0);

  const capUp = Math.max(0, A().maxUp ?? 20);
  const capDown = Math.max(0, A().maxDown ?? 25);
  const up = Math.min(rawUp, capUp);
  const down = Math.min(rawDown, capDown);

  const delta = up - down;
  return {
    score: clamp(Math.round(rawScore + delta), 0, 100),
    raw: rawScore,
    delta,
    rows,
    clampedUp: rawUp > capUp,
    clampedDown: rawDown > capDown,
  };
}

/**
 * Validate a proposed adjustment before it is written.
 * Returns an error string, or null if it is allowed.
 */
function validate(points) {
  if (!enabled()) return 'Manual adjustments are switched off (`adjustments.enabled` in config.js).';
  if (!Number.isInteger(points) || points === 0) return 'Points must be a whole number other than zero.';
  const max = maxSingle();
  if (Math.abs(points) > max) {
    return `The most any single adjustment can move a score is **${max}**. Split it across separate, separately-justified adjustments if you really mean more than that — or ask yourself whether the number is the problem.`;
  }
  return null;
}

/** A one-line summary of what a set of adjustments did, for the card. */
function summarise(applied) {
  if (!applied.rows.length) return null;
  const sign = applied.delta > 0 ? '+' : '';
  const lines = applied.rows
    .slice(0, 6)
    .map((r) => {
      const s = r.points > 0 ? `+${r.points}` : String(r.points);
      return `\`${s.padStart(3)}\` <@${r.author_id}> — ${r.reason.slice(0, 120)} · <t:${Math.floor(
        r.created_at / 1000
      )}:R>`;
    })
    .join('\n');

  const capNote = [
    applied.clampedUp ? `capped at +${A().maxUp ?? 20}` : null,
    applied.clampedDown ? `capped at −${A().maxDown ?? 25}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    header: `Manual adjustments — ${applied.raw} → **${applied.score}** (${sign}${applied.delta})`,
    body:
      lines +
      (capNote ? `\n_${capNote}._` : '') +
      `\n_These age out of the window on their own._`,
  };
}

module.exports = { applyTo, validate, summarise, enabled, maxSingle };

const config = require('../config');
const db = require('./db');

/**
 * MANUAL SCORE ADJUSTMENTS
 *
 * The problem this solves is real and the scoring engine cannot solve it on
 * its own: the score measures ACTIVITY. Someone can sit at 90 having done
 * something that should stop a promotion dead, and nothing in the numbers
 * knows about it. The reverse is just as true — the bot cannot see a dispute
 * mediated in DMs, an hour spent training a new hire in voice, or the build
 * that took someone a weekend.
 *
 * But the obvious implementation — let a Head Mod edit the number — would
 * destroy the one thing the score is good for. Its entire value is that it is
 * not negotiable: "this is what you actually did." The moment ±15 can be
 * handed out silently, the number stops being a measurement and becomes an
 * opinion wearing a measurement's clothes, and nobody reading it later can
 * tell which parts are which.
 *
 * So an adjustment here is a LEDGER ENTRY, never an edit. Four rules make the
 * difference, and each one exists because of a specific way this feature goes
 * wrong elsewhere:
 *
 *   ATTRIBUTED  Every entry names who issued it and why. A Head Mod who
 *               likes someone can still add points — everyone can see that
 *               they did, which is the part that matters.
 *
 *   VISIBLE     The card always shows the raw score AND the adjusted one.
 *               A score you cannot take apart again is not evidence.
 *
 *   EXPIRING    90 days by default. A deduction for a bad week in March
 *               should not still be dragging someone down in September, and
 *               nobody ever remembers to remove it by hand.
 *
 *   CAPPED      15 points per entry, 30 total. If you need to move somebody
 *               further than that, you do not need arithmetic — you need
 *               /demote. The cap exists to say so.
 */

const A = () => config.adjustments ?? {};
const enabled = () => A().enabled !== false;

const maxSingle = () => Math.abs(A().maxSingle ?? 15);
const maxTotal = () => Math.abs(A().maxTotal ?? 30);
const expiryDays = () => A().expiryDays ?? 90;

/** Active entries only — not revoked, not expired. */
function active(guildId, userId) {
  if (!enabled()) return [];
  return db.activeAdjustments(guildId, userId);
}

/**
 * The net swing, clamped to maxTotal. Returned alongside the uncapped figure
 * so the card can say "−45, capped at −30" rather than silently swallowing
 * the difference — a cap you cannot see is just a bug from the user's side.
 */
function net(guildId, userId) {
  const rows = active(guildId, userId);
  const raw = rows.reduce((s, r) => s + r.points, 0);
  const cap = maxTotal();
  const capped = Math.max(-cap, Math.min(cap, raw));
  return { rows, raw, delta: capped, wasCapped: capped !== raw };
}

/** Apply the ledger to a computed score. Never moves it outside 0–100. */
function apply(score, guildId, userId) {
  const n = net(guildId, userId);
  const adjusted = Math.max(0, Math.min(100, score + n.delta));
  return {
    raw: score,
    score: adjusted,
    delta: n.delta,
    effective: adjusted - score, // what actually landed after the 0–100 clamp
    rows: n.rows,
    wasCapped: n.wasCapped,
    uncapped: n.raw,
  };
}

/** Is there an active deduction? This is what blocks a promotion. */
function hasDeduction(guildId, userId) {
  return active(guildId, userId).some((r) => r.points < 0);
}

/**
 * Validate a proposed entry before it is written.
 * Returns an error string, or null if it is fine.
 */
function validate(points, reason) {
  if (!enabled()) return 'Manual adjustments are switched off in config.js.';
  if (!Number.isInteger(points) || points === 0) return 'Points must be a whole number, and not zero.';
  if (Math.abs(points) > maxSingle()) {
    return (
      `${Math.abs(points)} is over the ${maxSingle()}-point limit for a single adjustment.\n\n` +
      'That limit is deliberate. If someone needs moving further than this, the answer is ' +
      '`/demote` or a removal — not arithmetic. Docking 40 points is a way of avoiding the decision.'
    );
  }
  const text = String(reason ?? '').trim();
  if (text.length < 8) {
    return 'Give a real reason. It is shown on their card and in their DM — an adjustment nobody can explain later is worse than none.';
  }
  return null;
}

/** When a new entry should lapse, or null for permanent. */
function expiryFor(days) {
  const d = days ?? expiryDays();
  if (!d || d <= 0) return null;
  return Date.now() + d * 86400000;
}

/** One-line summary for a card field. */
function summarise(guildId, userId) {
  const n = net(guildId, userId);
  if (!n.rows.length) return null;
  const sign = n.delta > 0 ? '+' : '';
  const lines = n.rows.slice(0, 6).map((r) => {
    const when = `<t:${Math.floor(r.created_at / 1000)}:R>`;
    const until = r.expires_at ? `, lapses <t:${Math.floor(r.expires_at / 1000)}:R>` : ', permanent';
    return `\`${r.points > 0 ? '+' : ''}${r.points}\` <@${r.author_id}> ${when}${until}\n  ${r.reason.slice(0, 140)}`;
  });
  return {
    delta: n.delta,
    header: `${sign}${n.delta} from ${n.rows.length} adjustment${n.rows.length === 1 ? '' : 's'}` +
      (n.wasCapped ? ` (${n.raw} before the ±${maxTotal()} cap)` : ''),
    body: lines.join('\n'),
  };
}

module.exports = {
  enabled,
  active,
  net,
  apply,
  hasDeduction,
  validate,
  expiryFor,
  summarise,
  maxSingle,
  maxTotal,
  expiryDays,
};

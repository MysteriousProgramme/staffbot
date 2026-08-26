const config = require('../config');
const db = require('./db');
const R = require('./ranks');
const { computeScore, summariseVouches } = require('./scoring');

/**
 * STANDING — the system for everyone above Trial Staff.
 *
 * The trial system answers "do we keep them?" once and then falls silent.
 * That was the whole scope of the original build, and it left four fifths of
 * the ladder with nothing but raw numbers and no opinion about them.
 *
 * Standing asks two questions instead of one, continuously:
 *
 *   HOLD    — are they still doing the job they hold the rank for?
 *   PROMOTE — are they doing the job above it?
 *
 * Three things make it different from a trial review, and all three matter:
 *
 *   1. A ROLLING window, not a fixed one. There is no "end" to be reviewed
 *      at, so the window is the last N days, always.
 *   2. RANK-APPROPRIATE targets. Judging a Head Mod on ticket volume rewards
 *      them for doing the job two rungs below.
 *   3. TRAJECTORY. The same window last month is scored too. A 62 climbing
 *      and a 62 falling are completely different conversations, and the
 *      single number hides which one you are having.
 */

const S = () => config.standing ?? {};
const DAY = 86400000;

const enabled = () => S().enabled !== false;

/** The per-rank target/weight profile, or null to fall back to trial numbers. */
function profileFor(rankKey) {
  return S().profiles?.[rankKey] ?? null;
}

// Metrics that are running totals and therefore scale with the length of the
// window. Everything else does not: `responseSpeed` is an AVERAGE (a 7-day
// window doesn't make people reply faster), and `channelBreadth` is a count of
// distinct places, which grows nothing like linearly. Scaling either would
// quietly corrupt every short-window score.
const CUMULATIVE = new Set([
  'ticketsHandled',
  'inGameActivity',
  'modActions',
  'staffPresence',
  'publicActivity',
  'activeDays',
]);

/**
 * A rank profile's targets, adjusted for a window that isn't the one they were
 * written for. The profile numbers are for `windowDays` (30 by default); asking
 * for a 7-day view without this makes every single person look like they have
 * collapsed.
 */
function scaledProfile(rankKey, windowDays) {
  const p = profileFor(rankKey);
  if (!p) return null;

  const base = windowDaysFor(rankKey);
  if (!windowDays || windowDays === base) return { targets: p.targets, weights: p.weights };

  const factor = windowDays / base;
  const targets = {};
  for (const [key, value] of Object.entries(p.targets ?? {})) {
    if (!CUMULATIVE.has(key)) {
      targets[key] = value;
      continue;
    }
    let scaled = Math.max(1, Math.round(value * factor));
    // You cannot be active on more days than the window has.
    if (key === 'activeDays') scaled = Math.min(scaled, windowDays);
    targets[key] = scaled;
  }
  return { targets, weights: p.weights };
}

function windowDaysFor(rankKey) {
  const p = profileFor(rankKey);
  return Math.max(1, p?.windowDays ?? S().windowDays ?? 30);
}

/** Days someone must hold a rank before promotion out of it is considered. */
function tenureNeeded(rankKey) {
  const v = S().minTenureDays?.[rankKey];
  return typeof v === 'number' && v > 0 ? v : null;
}

/** Score one window using this rank's profile, scaled to the window length. */
function scoreWindow(guildId, userId, rankKey, from, to, windowDays) {
  const metrics = db.getMetrics(guildId, userId, from, to);
  const p = scaledProfile(rankKey, windowDays ?? Math.round((to - from) / DAY));
  return { metrics, ...computeScore(metrics, p) };
}

/**
 * Everything known about where a ranked staff member currently stands.
 * Pure data — no embeds, so the digest and /review can both use it.
 */
function assess(guildId, staffRow, { days = null } = {}) {
  const rankKey = staffRow.rank_key;
  const rankIdx = R.indexOfKey(rankKey);
  const rank = R.rankByKey(rankKey);
  const next = R.ranks[rankIdx + 1] ?? null;
  const atTop = !next;

  const windowDays = days ?? windowDaysFor(rankKey);
  const to = Date.now();
  const from = to - windowDays * DAY;

  const current = scoreWindow(guildId, staffRow.user_id, rankKey, from, to, windowDays);

  // The same length of window, immediately before this one.
  let previous = null;
  if (S().compareToPrevious !== false) {
    const prevTo = from - 1;
    const prevFrom = prevTo - windowDays * DAY;
    const p = scoreWindow(guildId, staffRow.user_id, rankKey, prevFrom, prevTo, windowDays);
    // Only meaningful if they existed and did anything in it. A brand new
    // hire would otherwise read as "down 60 points" from a window of zeros.
    const hadData = Object.values(p.metrics).some((v) => typeof v === 'number' && v > 0);
    if (hadData) previous = { score: p.score, from: prevFrom, to: prevTo };
  }

  const delta = previous ? current.score - previous.score : null;

  // Time in rank.
  const tenureDays = Math.max(0, Math.floor((to - (staffRow.rank_since ?? to)) / DAY));
  const needed = atTop ? null : tenureNeeded(rankKey);
  const tenureMet = needed === null ? true : tenureDays >= needed;

  // Vouches for ranked staff are keyed to the current rank, so they reset on
  // every rank change: a vouch means "ready for the NEXT step from here", and
  // carrying old ones forward would promote someone twice on one vote.
  const cycle = staffRow.rank_since;
  const vouches = summariseVouches(db.getVouches(guildId, staffRow.user_id, cycle));

  // Two separate leave questions, and they are not the same one.
  //
  //   loaHeavy    — most of the window they are being SCORED on was leave, so
  //                 the numbers are measuring an absence you already approved.
  //   onLeaveNow  — they are away RIGHT NOW. A leave that started yesterday
  //                 contributes nothing to a backward-looking window, so
  //                 without this the bot would cheerfully report someone as
  //                 slipping on the same day you approved their time off.
  const loaDays = db.loaDaysInWindow(guildId, staffRow.user_id, from, to);
  const loaHeavy = loaDays >= windowDays * (S().loaGraceFraction ?? 0.25);
  const onLeaveNow = Boolean(db.activeLoa(guildId, staffRow.user_id));
  const excused = loaHeavy || onLeaveNow;

  // Drift needs a streak. One bad month is a bad month.
  const streakNeeded = Math.max(1, S().driftStreak ?? 2);
  const underNow = current.score < (S().holdBar ?? 45);
  const underBefore = previous ? previous.score < (S().holdBar ?? 45) : false;
  const drifting =
    !excused && underNow && (streakNeeded <= 1 || (previous !== null && underBefore));

  return {
    userId: staffRow.user_id,
    rankKey,
    rank,
    next,
    atTop,
    windowDays,
    from,
    to,
    score: current.score,
    breakdown: current.breakdown,
    skipped: current.skipped,
    metrics: current.metrics,
    previous,
    delta,
    tenureDays,
    tenureNeeded: needed,
    tenureMet,
    vouches,
    cycle,
    loaDays,
    loaHeavy,
    onLeaveNow,
    excused,
    drifting,
    onlyOneBadWindow: !excused && underNow && !drifting,
    verdict: standingVerdict({
      score: current.score,
      rankName: rank?.name ?? rankKey,
      atTop,
      next,
      tenureMet,
      tenureDays,
      tenureNeeded: needed,
      vouches,
      drifting,
      loaHeavy,
      onLeaveNow,
      excused,
      delta,
    }),
  };
}

/**
 * The opinion. Deliberately four states rather than the trial's pass/fail:
 * most of a staff team, most of the time, is neither being promoted nor being
 * removed, and a system that can only say those two things gets ignored.
 */
function standingVerdict(a) {
  const holdBar = S().holdBar ?? 45;
  const promoteBar = S().promoteBar ?? 80;

  if (a.excused) {
    return {
      code: 'on_leave',
      label: 'ON LEAVE',
      color: config.colors.neutral,
      reason: a.loaHeavy
        ? 'Most of this window was approved leave. The numbers below are measuring an absence you already agreed to — read them as context, not as performance.'
        : 'They are on approved leave right now. The window below is mostly from before it, so it still means something — but nothing here is being held against them until they are back.',
    };
  }

  if (a.drifting) {
    return {
      code: 'drifting',
      label: 'DRIFTING',
      color: config.colors.belowBar,
      reason: `Score ${a.score} is under the ${holdBar} hold bar, and so was the window before it. This is the point to have a conversation — not to demote. Ask what changed before deciding anything.`,
    };
  }

  if (a.score < holdBar) {
    return {
      code: 'quiet_window',
      label: 'QUIET WINDOW',
      color: config.colors.borderline,
      reason: `Score ${a.score} is under the ${holdBar} hold bar, but the window before it was fine. One quiet month is a quiet month — worth noticing, not worth acting on.`,
    };
  }

  if (a.score >= promoteBar && a.atTop) {
    return {
      code: 'steady',
      label: 'HOLDING THE TOP',
      color: config.colors.ready,
      reason: `Score ${a.score}. There is no rank above this one, so there is nothing to be promoted into — this is what "still doing the job" looks like at the top of the ladder.`,
    };
  }

  if (a.score >= promoteBar) {
    if (!a.tenureMet) {
      return {
        code: 'too_soon',
        label: 'READY, TOO SOON',
        color: config.colors.borderline,
        reason: `Score ${a.score} clears the ${promoteBar} promote bar, but they have held **${a.rankName ?? 'this rank'}** for ${a.tenureDays} of the ${a.tenureNeeded} days expected first. The number says yes; the calendar says wait.`,
      };
    }
    if (a.vouches.state === 'fail') {
      return {
        code: 'steady',
        label: 'STEADY',
        color: config.colors.neutral,
        reason: `Score ${a.score} clears the promote bar, but senior staff vouched against (${a.vouches.yes} yes / ${a.vouches.no} no). Numbers do not overrule people.`,
      };
    }
    if (a.vouches.state === 'insufficient') {
      return {
        code: 'candidate',
        label: 'PROMOTION CANDIDATE',
        color: config.colors.borderline,
        reason: `Score ${a.score} clears the ${promoteBar} bar and they have the time in rank. ${
          a.vouches.total
        }/${config.scoring.vouches.minimum} vouches are in — run \`/vouch\` on them to settle it.`,
      };
    }
    return {
      code: 'ready',
      label: `READY FOR ${(a.next?.name ?? 'THE NEXT RANK').toUpperCase()}`,
      color: config.colors.ready,
      reason: `Score ${a.score}, ${a.tenureDays} days in rank, and senior staff vouched ${a.vouches.yes}–${a.vouches.no} in favour. Everything the bot can check says yes.`,
    };
  }

  const trend =
    a.delta === null
      ? ''
      : a.delta >= 5
        ? ` Up ${a.delta} on last window — worth saying so to them.`
        : a.delta <= -5
          ? ` Down ${Math.abs(a.delta)} on last window. Not a problem yet, but it is a direction.`
          : '';

  return {
    code: 'steady',
    label: 'STEADY',
    color: config.colors.neutral,
    reason: `Score ${a.score} sits between the ${holdBar} hold bar and the ${promoteBar} promote bar. They are doing the job they hold the rank for.${trend}`,
  };
}

/**
 * Everyone worth mentioning this week, without anyone running a command.
 * This is the difference between a bot you consult and a bot that tells you.
 */
function watch(guildId) {
  const ready = [];
  const candidates = [];
  const drifting = [];
  if (!enabled()) return { ready, candidates, drifting };

  for (const staff of db.listStaff(guildId)) {
    // Trials have their own section of the digest, and their own system.
    if (['active', 'midpoint_posted', 'awaiting_review'].includes(staff.trial_state ?? '')) continue;
    if (!R.rankByKey(staff.rank_key)) continue;

    let a;
    try {
      a = assess(guildId, staff);
    } catch {
      continue;
    }

    if (a.verdict.code === 'ready') ready.push(a);
    else if (a.verdict.code === 'candidate' || a.verdict.code === 'too_soon') candidates.push(a);
    else if (a.verdict.code === 'drifting') drifting.push(a);
  }

  const byScore = (x, y) => y.score - x.score;
  return {
    ready: ready.sort(byScore),
    candidates: candidates.sort(byScore),
    drifting: drifting.sort((x, y) => x.score - y.score),
  };
}

module.exports = {
  assess,
  watch,
  profileFor,
  scaledProfile,
  scoreWindow,
  windowDaysFor,
  tenureNeeded,
  standingVerdict,
  enabled,
};

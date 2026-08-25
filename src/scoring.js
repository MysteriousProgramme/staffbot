const config = require('../config');

const BAR = (pct) => {
  const filled = Math.round(Math.min(1, Math.max(0, pct)) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
};

function fmt(value, def) {
  if (def.unit === 'min') {
    if (value === null || value === undefined) return 'n/a';
    if (value < 1) return '<1 min';
    if (value >= 120) return `${(value / 60).toFixed(1)} hr`;
    return `${Math.round(value)} min`;
  }
  return String(value ?? 0);
}

/**
 * Turn raw metric totals into a weighted 0-100 score.
 *
 * - `direction: 'lower'` metrics score better as the number goes DOWN
 *   (used for response time).
 * - `dataKey` lets a metric bow out entirely when there's no data to judge
 *   it on — a trial who handled zero tickets shouldn't be scored 0% on
 *   response speed, they should be scored on the other metrics instead.
 *   Their zero tickets already cost them under ticketsHandled; charging
 *   them twice for the same absence would be double jeopardy.
 */
function computeScore(metrics) {
  const defs = config.scoring.metrics;

  // A metric can bow out two ways: `dataKey` (no data for this person yet) or
  // `requires` (the feature it depends on isn't configured at all).
  const configured = (path) =>
    String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), config);
  const isSetUp = (path) => {
    const v = configured(path);
    return Boolean(v) && !String(v).startsWith('0');
  };

  const active = Object.entries(defs).filter(([, d]) => {
    if (!d.enabled) return false;
    if (d.requires && !isSetUp(d.requires)) return false;
    if (d.dataKey && !(metrics[d.dataKey] > 0)) return false;
    return true;
  });

  const skipped = Object.entries(defs)
    .filter(
      ([, d]) =>
        d.enabled &&
        ((d.requires && !isSetUp(d.requires)) || (d.dataKey && !(metrics[d.dataKey] > 0)))
    )
    .map(([, d]) => d.label);

  const totalWeight = active.reduce((s, [, d]) => s + d.weight, 0) || 1;

  let score = 0;
  const breakdown = [];

  for (const [key, def] of active) {
    const raw = metrics[key];
    const value = raw ?? 0;
    const target = def.target > 0 ? def.target : 1;

    let pct;
    if (def.direction === 'lower') {
      pct = value <= 0 ? 1 : Math.min(1, target / value);
    } else {
      pct = Math.min(1, value / target);
    }

    const share = def.weight / totalWeight;
    score += share * pct * 100;

    breakdown.push({
      key,
      label: def.label,
      help: def.help,
      value,
      display: fmt(value, def),
      targetDisplay: fmt(def.target, def),
      target: def.target,
      direction: def.direction ?? 'higher',
      pct,
      weightPct: Math.round(share * 100),
      bar: BAR(pct),
    });
  }

  breakdown.sort((a, b) => a.pct - b.pct); // weakest first — that's the conversation
  return { score: Math.round(score), breakdown, skipped };
}

function summariseVouches(rows) {
  const yes = rows.filter((r) => r.verdict === 'yes').length;
  const no = rows.filter((r) => r.verdict === 'no').length;
  const abstain = rows.filter((r) => r.verdict === 'abstain').length;
  const decisive = yes + no;
  const ratio = decisive > 0 ? yes / decisive : null;
  const { minimum, passRatio } = config.scoring.vouches;

  let state;
  if (rows.length < minimum) state = 'insufficient';
  else if (ratio !== null && ratio >= passRatio) state = 'pass';
  else state = 'fail';

  return { yes, no, abstain, total: rows.length, decisive, ratio, state, rows };
}

/**
 * Combine the numbers and the humans into one recommendation.
 * The bot never promotes anyone by itself — this is advice, not an action.
 */
function verdict(score, vouchSummary) {
  const { promote, belowBar } = config.scoring.autoFlag;

  if (score < belowBar) {
    return {
      code: 'below_bar',
      label: 'BELOW BAR',
      color: config.colors.belowBar,
      reason: `Score ${score} is under the ${belowBar} minimum. The numbers alone say this trial didn't work out.`,
    };
  }

  if (vouchSummary.state === 'fail') {
    return {
      code: 'below_bar',
      label: 'BELOW BAR',
      color: config.colors.belowBar,
      reason: `Senior staff vouched against (${vouchSummary.yes} yes / ${vouchSummary.no} no), which overrides a passing score.`,
    };
  }

  if (score >= promote && vouchSummary.state === 'pass') {
    return {
      code: 'ready',
      label: 'READY TO PROMOTE',
      color: config.colors.ready,
      reason: `Score ${score} clears the ${promote} bar and senior staff vouched ${vouchSummary.yes}–${vouchSummary.no} in favour.`,
    };
  }

  if (vouchSummary.state === 'insufficient') {
    return {
      code: 'borderline',
      label: 'AWAITING VOUCHES',
      color: config.colors.borderline,
      reason: `Score ${score} looks ${score >= promote ? 'strong' : 'workable'}, but only ${vouchSummary.total}/${config.scoring.vouches.minimum} required vouches are in. Run \`/vouch\` before deciding.`,
    };
  }

  return {
    code: 'borderline',
    label: 'BORDERLINE',
    color: config.colors.borderline,
    reason: `Score ${score} sits between ${belowBar} and ${promote}. Vouches are positive — this is a judgement call. Look at the weakest metric below.`,
  };
}

module.exports = { computeScore, summariseVouches, verdict, BAR, fmt };

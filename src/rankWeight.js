const config = require('../config');

/**
 * How demanding each rank is, so scores from different ranks can share a board.
 *
 * A score is always "percent of your own rank's targets". That makes it a fair
 * measure of effort against expectation, but it makes a terrible leaderboard:
 * whoever has the softest targets wins, and the person clearing a harder bar at
 * 84% sits below someone clearing an easier one at 90%.
 *
 * So each rank gets a weight derived from its own targets and weights — no
 * hand-tuned table, nothing to keep in sync. The most demanding rank scores 1.0
 * and everyone else is scaled against it:
 *
 *     boardScore = rawScore x weightFor(rank)
 *
 * Set `standing.rankWeights` in config.js to override any of it by hand.
 */

const S = () => config.standing ?? {};
const metrics = () => config.scoring.metrics;
const activeKeys = () =>
  Object.keys(metrics()).filter((k) => metrics()[k].enabled !== false);

/**
 * Trial staff have no standing profile — they are measured against the flat
 * scoring targets — so those stand in as their profile here.
 */
function profileFor(rankKey) {
  const fromStanding = S().profiles?.[rankKey];
  if (fromStanding) return fromStanding;

  const m = metrics();
  const keys = activeKeys();
  return {
    targets: Object.fromEntries(keys.map((k) => [k, m[k].target])),
    weights: Object.fromEntries(keys.map((k) => [k, m[k].weight])),
  };
}

/** Every rank that can appear on a board, lowest first. */
const ladder = () => config.ranks.map((r) => r.key);

/**
 * The span of each target across the whole ladder, so a target can be read as
 * a fraction of the most demanding version of itself.
 */
function spans() {
  const out = {};
  for (const m of activeKeys()) {
    const vals = ladder().map((r) => profileFor(r).targets?.[m] ?? metrics()[m].target);
    out[m] = { min: Math.min(...vals), max: Math.max(...vals) };
  }
  return out;
}

/**
 * Raw demand for one rank, 0..1.
 *
 * Each target becomes a fraction of the hardest version of itself, weighted by
 * how much that rank's own scoring cares about it. responseSpeed is inverted:
 * it is a time allowance, so a SMALLER number is the harder ask.
 */
function demandFor(rankKey, span = spans()) {
  const p = profileFor(rankKey);
  const m = metrics();

  let total = 0;
  let weightSum = 0;

  for (const key of activeKeys()) {
    const target = p.targets?.[key] ?? m[key].target;
    const weight = p.weights?.[key] ?? m[key].weight;
    if (!target || !weight) continue;

    const norm =
      m[key].direction === 'lower'
        ? span[key].min / target
        : target / span[key].max;

    total += weight * Math.max(0, Math.min(1, norm));
    weightSum += weight;
  }

  return weightSum ? total / weightSum : 0;
}

/** Every rank's weight, keyed by rank, with the hardest at 1.0. */
function weights() {
  const manual = S().rankWeights;
  const span = spans();

  const raw = {};
  for (const key of ladder()) raw[key] = demandFor(key, span);

  const max = Math.max(...Object.values(raw), 0.0001);
  const out = {};
  for (const key of ladder()) {
    out[key] = manual?.[key] !== undefined ? Number(manual[key]) : raw[key] / max;
  }
  return out;
}

function weightFor(rankKey) {
  return weights()[rankKey] ?? 1;
}

/**
 * A score as it should appear on a board shared with other ranks. Pass
 * normalise:false to get the raw number back untouched, which is what a
 * single-rank board wants — everyone on it shares a bar already.
 */
function boardScore(rawScore, rankKey, { normalise = true } = {}) {
  if (!normalise) return Math.round(rawScore);
  return Math.round(rawScore * weightFor(rankKey));
}

module.exports = { profileFor, demandFor, weights, weightFor, boardScore };

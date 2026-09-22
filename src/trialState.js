/**
 * What kind of trial somebody is on, and what that means for measuring them.
 *
 * There are two, and they look identical in the staff row unless you check
 * `trial_kind`:
 *
 *   hire       a new person being assessed. They hold the bottom rank and are
 *              scored against the flat targets, because there is no rank yet
 *              to measure them against.
 *   promotion  somebody already wearing a senior rank, proving they can hold
 *              it. They are scored against THAT rank's targets.
 *
 * Before promotion probations existed, "on trial" and "is a Trial Staff hire"
 * were the same thing, and a dozen call sites quietly assumed it. Adding
 * probations made that assumption wrong in three places at once — a
 * probationary Head Mod was listed as Trial Staff, weighted at less than half
 * their rank, and scored against hire targets. Hence one place that knows the
 * difference.
 */

const OPEN_STATES = ['active', 'midpoint_posted', 'awaiting_review'];

/** Is there a trial of any kind running? */
const isOpen = (row) => OPEN_STATES.includes(row?.trial_state ?? '');

/** Someone senior proving they can hold the rank they are already wearing. */
const isPromotion = (row) => isOpen(row) && row?.trial_kind === 'promotion';

/** A new hire being assessed. Anything without an explicit kind is one. */
const isHire = (row) => isOpen(row) && !isPromotion(row);

/**
 * The rank this person should be listed and measured against.
 *
 * For a hire this is already their rank — /trial start puts them on the bottom
 * rung — so the only case that needs saying out loud is the probation, where
 * the rank in the row is the right answer and "they are on a trial" is not.
 */
const scoringRank = (row) => row?.rank_key ?? null;

module.exports = { OPEN_STATES, isOpen, isPromotion, isHire, scoringRank };

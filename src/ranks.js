const config = require('../config');

const ranks = config.ranks;

function rankByKey(key) {
  return ranks.find((r) => r.key === key) || null;
}

function indexOfKey(key) {
  return ranks.findIndex((r) => r.key === key);
}

/** Highest ladder rank the member actually holds a role for. -1 if none. */
function memberRankIndex(member) {
  let best = -1;
  for (let i = 0; i < ranks.length; i++) {
    if (member.roles.cache.has(ranks[i].roleId)) best = i;
  }
  return best;
}

/** Owners and override roles sit above everything. */
function isOverride(member) {
  if (member.guild.ownerId === member.id) return true;
  return config.permissions.overrideRoleIds.some((id) => member.roles.cache.has(id));
}

/**
 * Should this member be TRACKED as staff — measured, scored, expected to have
 * a Minecraft name? Holding a rank role is not enough: an Owner who also wears
 * the Staff role for the colour is leadership, not someone on a trial ladder.
 */
function isTracked(member) {
  if (memberRankIndex(member) < 0) return false;
  if (config.permissions.trackOverrides) return true;
  return !isOverride(member);
}

/**
 * Effective authority level used for all comparisons. Three tiers above the
 * ladder:
 *   ranks.length + 1  the Discord server owner — above absolutely everyone
 *   ranks.length      override roles (Founder/Owner/Co-Owner) — above every
 *                     rank, but NOT above each other
 *   0..ranks.length-1 the ladder itself
 */
function authorityIndex(member) {
  if (member.guild?.ownerId === member.id) return ranks.length + 1;
  if (isOverride(member)) return ranks.length;
  return memberRankIndex(member);
}

/**
 * Can `actor` run a command gated at `minRankKey`?
 */
function meetsRequirement(member, minRankKey) {
  const need = indexOfKey(minRankKey);
  if (need === -1) return isOverride(member);
  return authorityIndex(member) >= need;
}

/**
 * Core safety rule: you may only act on people strictly below you,
 * and you may only place someone at a rank strictly below your own.
 * Returns null if allowed, or a human-readable reason if blocked.
 */
function checkActionAllowed(actor, targetMember, destinationIndex) {
  const actorIdx = authorityIndex(actor);
  const targetIdx = authorityIndex(targetMember);

  if (actor.id === targetMember.id) {
    return "You can't change your own rank.";
  }
  if (targetIdx >= actorIdx) {
    return `**${targetMember.user.username}** is at or above your own rank. You can only manage people below you.`;
  }
  if (destinationIndex !== null && destinationIndex >= actorIdx) {
    return `You can't place someone at **${ranks[destinationIndex]?.name ?? 'that rank'}** — it's at or above your own rank.`;
  }
  return null;
}

/** Swap ladder roles so the member holds exactly one (or none). */
async function applyRank(member, destinationIndex, reason) {
  const ladderIds = ranks.map((r) => r.roleId);
  const toRemove = ladderIds.filter(
    (id, i) => member.roles.cache.has(id) && i !== destinationIndex
  );
  const target = destinationIndex >= 0 ? ranks[destinationIndex] : null;

  if (toRemove.length) await member.roles.remove(toRemove, reason);
  if (target && !member.roles.cache.has(target.roleId)) {
    await member.roles.add(target.roleId, reason);
  }

  const teamRole = config.staffTeamRoleId;
  if (teamRole) {
    if (target && !member.roles.cache.has(teamRole)) {
      await member.roles.add(teamRole, reason);
    } else if (!target && member.roles.cache.has(teamRole)) {
      await member.roles.remove(teamRole, reason);
    }
  }
}

module.exports = {
  ranks,
  isTracked,
  rankByKey,
  indexOfKey,
  memberRankIndex,
  isOverride,
  authorityIndex,
  meetsRequirement,
  checkActionAllowed,
  applyRank,
};

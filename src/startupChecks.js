const config = require('../config');
const R = require('./ranks');

/**
 * Things that can only be checked once we can actually see the server.
 *
 * The important one is the vouch count. `/vouch` needs
 * scoring.vouches.minimum distinct people before the vote counts at all, and
 * tightening permissions.vouch can quietly leave fewer eligible people than
 * that — at which point every trial parks on "AWAITING VOUCHES" forever and
 * nothing explains why. Worth a loud warning on boot rather than a confused
 * Head Mod two weeks later.
 */
async function run(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await checkGuild(guild);
    } catch (e) {
      console.error('[startup] check failed:', e.message);
    }
  }
}

async function checkGuild(guild) {
  const members = await guild.members.fetch();
  const needed = config.scoring?.vouches?.minimum ?? 2;

  const vouchIdx = R.indexOfKey(config.permissions.vouch);
  const eligibleRoleIds = R.ranks.slice(Math.max(0, vouchIdx)).map((r) => r.roleId);
  const overrideIds = config.permissions.overrideRoleIds ?? [];

  const eligible = members.filter(
    (m) =>
      !m.user.bot &&
      (m.id === guild.ownerId ||
        overrideIds.some((id) => m.roles.cache.has(id)) ||
        eligibleRoleIds.some((id) => m.roles.cache.has(id)))
  );

  const rankName = R.rankByKey(config.permissions.vouch)?.name ?? config.permissions.vouch;

  if (eligible.size >= needed) {
    console.log(
      `[startup] ${eligible.size} people can cast a /vouch (${rankName}+ and override roles) · ${needed} needed`
    );
    return;
  }

  console.warn(
    '\n  ============================================================\n' +
      `   WARNING: only ${eligible.size} person/people can cast a /vouch,\n` +
      `   but scoring.vouches.minimum is ${needed}.\n` +
      '  ============================================================\n\n' +
      `   Right now /vouch is limited to ${rankName} and above, plus your\n` +
      '   override roles. With too few eligible people, no trial can ever\n' +
      '   reach the vouch minimum, so every review card will sit on\n' +
      '   "AWAITING VOUCHES" and nothing will ever be flagged READY.\n\n' +
      '   Pick one:\n' +
      `     - lower permissions.vouch (e.g. back to 'headstaff')\n` +
      `     - or set scoring.vouches.minimum to ${Math.max(1, eligible.size)}\n`
  );
}

/** Who can run what, printed once so the restriction is visible and deliberate. */
function describePermissions() {
  const name = (key) => R.rankByKey(key)?.name ?? key;
  console.log(
    `[perms] manage staff: ${name(config.permissions.manageStaff)}+ · ` +
      `vouch: ${name(config.permissions.vouch)}+ · ` +
      `review/link: ${name(config.permissions.review)}+ · ` +
      `${(config.permissions.overrideRoleIds ?? []).length} override role(s) bypass everything`
  );
}

module.exports = { run, describePermissions };

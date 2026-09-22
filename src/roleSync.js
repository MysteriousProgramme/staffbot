'use strict';

// Discord roles → LuckPerms groups.
//
// This half decides what someone is entitled to, from the roles they hold. The plugin half
// applies it, because only it can reach LuckPerms. Neither side could do both: the plugin
// does not know your Discord role ids, and the bot has no way into the permission plugin.
//
// What gets written is desired STATE, not a command. A command is lost if the Minecraft
// server happens to be down when someone starts boosting; a row saying "this person should
// have booster" is still true in the morning, and the plugin applies it when it next sees
// them. The plugin also refuses to grant any group its own config does not list, so a
// mistake here cannot hand out admin.

const config = require('./../config');
const tempest = require('./tempest');

const UPSERT = `INSERT INTO tempest_role_sync (discord_id, groups, updated_at)
                VALUES (?,?,?)
                ON DUPLICATE KEY UPDATE groups = VALUES(groups), updated_at = VALUES(updated_at)`;

const READ = 'SELECT groups FROM tempest_role_sync WHERE discord_id = ?';

function settings() {
  return (config.tempest && config.tempest.roleSync) || {};
}

function enabled() {
  return Boolean(tempest.enabled() && settings().enabled);
}

/**
 * Normalises a mapping's role ids.
 *
 * Accepts a single id or an array, so a one-role mapping does not have to be written as a
 * list and a multi-role one does not need a separate shape.
 */
function roleIdsOf(mapping) {
  const raw = mapping.roleIds ?? mapping.roleId ?? [];
  return (Array.isArray(raw) ? raw : [raw]).map(String).filter((id) => id && id.trim() !== '');
}

/** The mappings that are actually usable — a group name and at least one role id. */
function activeMappings() {
  return (settings().mappings || []).filter(
    (m) => m && m.group && String(m.group).trim() !== '' && roleIdsOf(m).length > 0
  );
}

/**
 * Which groups this member is entitled to.
 *
 * A mapping matches when the member holds ANY of its role ids. That is what makes the
 * "tempest" style mapping work: several roles, one group, hold any of them and you qualify.
 */
function groupsFor(member) {
  const groups = [];
  for (const mapping of activeMappings()) {
    const ids = roleIdsOf(mapping);
    if (ids.some((id) => member.roles.cache.has(id))) {
      groups.push(String(mapping.group).toLowerCase());
    }
  }
  return [...new Set(groups)].sort();
}

/**
 * Writes a member's entitlement, if it has changed.
 *
 * Skips the write when nothing changed, because the plugin treats `updated_at` moving as
 * "there is work to do" — rewriting an identical row every time anybody edits a nickname
 * would have it re-applying groups all day.
 */
async function push(member) {
  if (!enabled()) return null;

  const groups = groupsFor(member).join(',');
  try {
    const rows = await tempest.query(READ, [member.id]);
    if (rows[0] && rows[0].groups === groups) return null;

    await tempest.query(UPSERT, [member.id, groups, Date.now()]);
    return groups;
  } catch (e) {
    console.error(`[roleSync] could not push ${member.id}: ${e.message}`);
    return null;
  }
}

/**
 * Walks every member and pushes their entitlement.
 *
 * Needed because Discord does not tell the bot what it missed while it was offline — a role
 * granted or removed during downtime produces no event to catch up on.
 */
async function reconcileAll(guild) {
  if (!enabled()) return { checked: 0, changed: 0 };

  const members = await guild.members.fetch();
  let changed = 0;
  for (const member of members.values()) {
    if (member.user.bot) continue;
    // Sequential on purpose: a few hundred small writes in a row is fine, and it keeps the
    // bot from opening a connection per member on a large server.
    // eslint-disable-next-line no-await-in-loop
    if ((await push(member)) !== null) changed++;
  }
  return { checked: members.size, changed };
}

/** Hooks the events, and does one reconcile at startup. */
function attach(client) {
  if (!enabled()) return;

  const mappings = activeMappings();
  if (mappings.length === 0) {
    console.log('[roleSync] on, but no mappings have both a group and a role id — nothing to do');
    return;
  }

  client.on('guildMemberUpdate', async (before, after) => {
    // Only when the roles actually changed. This event also fires for nicknames, timeouts
    // and avatar changes, none of which can alter an entitlement.
    if (before.roles.cache.size === after.roles.cache.size
        && before.roles.cache.every((r) => after.roles.cache.has(r.id))) {
      return;
    }
    const groups = await push(after);
    if (groups !== null) {
      console.log(`[roleSync] ${after.user.tag} → ${groups || '(none)'}`);
    }
  });

  // Someone can be given a role while they are not in the server, then join with it.
  client.on('guildMemberAdd', (member) => push(member));

  client.once('ready', async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { checked, changed } = await reconcileAll(guild);
        console.log(`[roleSync] ${mappings.length} mapping(s), ${checked} members checked, `
          + `${changed} updated`);
      } catch (e) {
        console.error(`[roleSync] startup reconcile failed: ${e.message}`);
      }
    }
  });
}

module.exports = { attach, push, reconcileAll, groupsFor, activeMappings, roleIdsOf, enabled };

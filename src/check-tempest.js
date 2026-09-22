'use strict';

// Does the bot's database connection actually work, and is the plugin on the
// other end of it?
//
// Separate from check-config.js because that one validates the config file on
// its own terms and never opens a socket. This one is for the moment you have
// just pasted connection details in and want to know before restarting the bot.

require('dotenv').config();
const config = require('../config');
const tempest = require('./tempest');
const roleSync = require('./roleSync');

// Every table the bot reads or writes, with what it is for. If one is missing,
// the plugin has not created it — which almost always means the plugin is
// pointed at a DIFFERENT database than the bot, or is still on SQLite.
const TABLES = {
  tempest_requests: 'moderation commands the plugin runs',
  tempest_links: 'Minecraft accounts linked to Discord',
  tempest_role_sync: 'Discord roles to LuckPerms groups',
};

async function main() {
  const s = config.tempest || {};
  const fromEnv = Boolean(process.env.TEMPEST_DB_PASSWORD);
  const password = process.env.TEMPEST_DB_PASSWORD || s.password || '';

  console.log('Connection the bot will use');
  console.log(`  host      ${s.host}:${s.port}`);
  console.log(`  user      ${s.user}`);
  console.log(`  database  ${s.database}`);
  console.log(`  password  ${password ? `set (${fromEnv ? 'TEMPEST_DB_PASSWORD' : 'config file'})` : 'EMPTY'}`);
  console.log(`  enabled   ${s.enabled === true}`);
  console.log(`  roleSync  ${config.tempest?.roleSync?.enabled === true}`);
  console.log('');

  if (!s.enabled) {
    console.log('tempest.enabled is false, so nothing else here would run. Stopping.');
    return 1;
  }

  const probe = await tempest.check();
  if (!probe.ok) {
    console.log(`Could not connect: ${probe.reason}`);
    console.log('');
    // The three that account for nearly every failure, and what each one means
    // — the driver's own wording points at the wrong thing often enough.
    console.log('  ECONNREFUSED  nothing is listening there. Usually the wrong host or');
    console.log('                port: a game panel gives the database its own address,');
    console.log('                which is not the address players connect to.');
    console.log('  ETIMEDOUT     something is listening but a firewall is dropping you.');
    console.log('                The database user needs to allow this machine.');
    console.log('  ER_ACCESS_*   host and port are right; the user or password is not.');
    return 1;
  }
  console.log('Connected.');

  const rows = await tempest.query('SHOW TABLES', []);
  const present = new Set(rows.map((r) => String(Object.values(r)[0]).toLowerCase()));

  let missing = 0;
  for (const [table, what] of Object.entries(TABLES)) {
    if (present.has(table)) {
      // eslint-disable-next-line no-await-in-loop
      const [{ n }] = await tempest.query(`SELECT COUNT(*) AS n FROM \`${table}\``, []);
      console.log(`  ${table.padEnd(20)} ${String(n).padStart(6)} rows   ${what}`);
    } else {
      missing++;
      console.log(`  ${table.padEnd(20)}    MISSING   ${what}`);
    }
  }

  if (missing) {
    console.log('');
    console.log(`${missing} table(s) the plugin should have created are not here. The bot is`);
    console.log('connected to a real database, just not the one the plugin uses. Check the');
    console.log("plugin's config points at this same host, database name and user.");
    return 1;
  }

  const mappings = roleSync.activeMappings();
  console.log('');
  console.log(mappings.length
    ? `Role sync: ${mappings.length} mapping(s) — ${mappings.map((m) => m.group).join(', ')}`
    : 'Role sync: on, but no mapping has both a group and a role id, so it will do nothing.');

  console.log('');
  console.log('Everything the bot needs is in place.');
  return 0;
}

main()
  .then(async (code) => {
    await tempest.close();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(e.message);
    await tempest.close();
    process.exit(1);
  });

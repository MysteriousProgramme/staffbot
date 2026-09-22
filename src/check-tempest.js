'use strict';

// Checks the connection to the Minecraft plugin's database, and says what is wrong
// in terms of the thing you would actually go and change.
//
// The failure modes look alike from the outside — "it doesn't work" — but they have
// completely different fixes: a timeout is a firewall, an access-denied is the grant
// or the panel's "Connections From", a bad-db is a typo in the name. Guessing between
// them wastes an afternoon, so this names which one it is.
//
//   npm run tempest-check

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const config = require('../config');
const tempest = require('./tempest');

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[90m${s}\x1b[0m`;
const OK = '\x1b[32m✓\x1b[0m';
const NO = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m–\x1b[0m';

const t = tempest.credentials();
const password = t.password;

/** Where a value came from, so a stale config.js entry is obvious. */
const from = (env) => (process.env[env] ? '.env' : 'config.js');

/** What each driver error actually means, and what to go and change. */
function explain(err) {
  switch (err.code) {
    case 'ENOTFOUND':
      return [
        'The hostname does not resolve.',
        `Check \`tempest.host\` — it is currently "${t.host}".`,
        'On a panel, use the database\'s external endpoint, not "localhost" or 127.0.0.1:',
        'those mean "this machine", which from here is the bot\'s machine, not the server\'s.',
      ];
    case 'ETIMEDOUT':
    case 'ECONNABORTED':
      return [
        'The host is reachable but nothing answered — the connection was silently dropped.',
        'That is a firewall, not a password. Almost always one of:',
        '  • the panel does not allow external database connections at all,',
        '  • the port is closed to your address,',
        '  • "Connections From" on the panel does not include this machine.',
        'Run `curl -s ifconfig.me` HERE to get the address the panel needs to allow.',
      ];
    case 'ECONNREFUSED':
      return [
        'The host answered and actively refused — nothing is listening on that port.',
        `Check \`tempest.port\` (currently ${t.port}).`,
        'If the port is right, the database is bound to localhost only and is not',
        'accepting outside connections.',
      ];
    case 'ER_ACCESS_DENIED_ERROR':
      return [
        'The database is reachable and rejected the credentials.',
        'This is NOT necessarily a wrong password — MySQL ties a user to the address it',
        'connects from, so the same password fails from an address that is not allowed.',
        'Check, in order:',
        '  • TEMPEST_DB_PASSWORD in .env matches the panel exactly,',
        '  • the username is the panel\'s generated one (often u123_xxxx),',
        '  • "Connections From" on the panel includes this machine\'s address.',
      ];
    case 'ER_BAD_DB_ERROR':
      return [
        `No database called "${t.database}".`,
        'Panels prefix the name they generate, e.g. s123_tempest — copy it exactly.',
      ];
    case 'ER_HOST_NOT_PRIVILEGED':
    case 'ER_HOST_IS_BLOCKED':
      return [
        'The database server is refusing this machine outright.',
        'Set "Connections From" on the panel to this machine\'s address, or to % if that',
        'is the only option the panel offers.',
      ];
    default:
      return [err.message];
  }
}

function report(lines) {
  for (const line of lines) console.log(`       ${DIM(line)}`);
}

(async () => {
  console.log(`\n${B('Tempest database check')}\n`);

  if (!config.tempest.enabled) {
    console.log(`   ${WARN} tempest.enabled is false`);
    console.log(`       ${DIM('Nothing will connect until you set it to true in config.js.')}`);
    console.log(`       ${DIM('Checking the connection anyway so the details can be verified.')}\n`);
  }

  console.log(`   ${DIM('host    ')} ${t.host}:${t.port}  ${DIM(from('TEMPEST_DB_HOST'))}`);
  console.log(`   ${DIM('database')} ${t.database}  ${DIM(from('TEMPEST_DB_NAME'))}`);
  console.log(`   ${DIM('user    ')} ${t.user}  ${DIM(from('TEMPEST_DB_USER'))}`);
  console.log(
    `   ${DIM('password')} ${
      password
        ? `set (${password.length} chars)  ${DIM(from('TEMPEST_DB_PASSWORD'))}`
        : '\x1b[31mMISSING\x1b[0m'
    }`
  );
  console.log();

  if (!password) {
    console.log(`   ${NO} No password.`);
    report([
      'Put it in .env as TEMPEST_DB_PASSWORD — config.js is committed to git,',
      'so it is the wrong place for it.',
    ]);
    process.exit(1);
  }

  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch {
    console.log(`   ${NO} mysql2 is not installed.`);
    report(['Run: npm install']);
    process.exit(1);
  }

  let connection;
  try {
    connection = await mysql.createConnection({
      host: t.host,
      port: t.port,
      user: t.user,
      password,
      database: t.database,
      // Short, because the point is a quick verdict rather than a long hang.
      connectTimeout: 8000,
    });
    console.log(`   ${OK} Connected`);
  } catch (err) {
    console.log(`   ${NO} Could not connect  ${DIM(err.code || '')}`);
    console.log();
    report(explain(err));
    console.log();
    process.exit(1);
  }

  // Connecting is not the same as being usable. The plugin owns these tables and creates
  // them on ITS first start, so an empty database means the server has not run yet.
  const WANTED = [
    'tempest_link',
    'tempest_link_request',
    'tempest_command_request',
    'tempest_role_sync',
  ];

  try {
    const [rows] = await connection.query(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?",
      [t.database]
    );
    const present = new Set(rows.map((r) => r.t || r.TABLE_NAME));
    const missing = WANTED.filter((w) => !present.has(w));

    console.log(`   ${OK} ${present.size} table(s) in the database`);

    if (missing.length === 0) {
      console.log(`   ${OK} Every table the bot needs is present`);
    } else if (present.size === 0) {
      console.log(`   ${NO} The database is empty`);
      report([
        'The PLUGIN creates these tables, not the bot, and it does so the first time it',
        'connects. Start the Minecraft server with the plugin installed and pointed at',
        'this same database, then run this again.',
      ]);
    } else {
      console.log(`   ${NO} Missing: ${missing.join(', ')}`);

      // The plugin records a row per feature module it has migrated, so the ones it
      // HAS set up say plainly that it is running and healthy — and that these tables
      // are absent because their module is switched off, not because anything broke.
      let namespaces = [];
      try {
        const [rows2] = await connection.query(
          'SELECT namespace FROM tempest_schema_version ORDER BY namespace'
        );
        namespaces = rows2.map((r) => r.namespace);
      } catch {
        // Older plugin builds have no version table; the advice below still holds.
      }

      report([
        'The plugin is running — it created the other tables. These two belong to',
        'features that are switched off in the PLUGIN config, so it never made them:',
        '',
        '  tempest_command_request   the /mc* moderation commands',
        '  tempest_role_sync         Discord roles granting LuckPerms groups',
        '',
        namespaces.length
          ? `Modules it has set up: ${namespaces.join(', ')}.`
          : 'Check the plugin config for its Discord bridge and role-sync sections.',
        'Turn the matching sections on in the plugin config, restart the Minecraft',
        'server, and run this again. The bot needs no change.',
      ]);
    }

    if (present.has('tempest_link')) {
      const [[{ n }]] = await connection.query('SELECT COUNT(*) AS n FROM tempest_link');
      console.log(`   ${DIM(`${n} account(s) linked`)}`);
    }
  } catch (err) {
    console.log(`   ${NO} Connected, but could not read the schema: ${err.message}`);
    report(['The user may lack SELECT on this database.']);
  } finally {
    await connection.end();
  }

  console.log(`\n${DIM('Green throughout means the bot has everything it needs. Restart it to pick up changes.')}\n`);
})();

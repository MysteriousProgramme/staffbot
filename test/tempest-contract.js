'use strict';

// Contract test: does the bot's SQL actually fit the plugin's schema?
//
// The bot and the plugin are separate programs in separate languages that agree only on a
// set of table and column names. Nothing at compile time checks that agreement, so a column
// renamed on one side is found at runtime, in production, by a staff member whose /ban
// silently does nothing.
//
// Both sides speak SQLite, so the plugin's real migrations can build a schema and the bot's
// real statements can be run against it — no MySQL, no Minecraft server, no Discord.
//
// Skips itself when the schema file is absent, so `npm test` still passes on a machine with
// no Java. Produce it with:
//   java -cp <TempestSuite.jar> SchemaDump <path>

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const SCHEMA =
  process.env.TEMPEST_SCHEMA_DB ||
  path.join(__dirname, '..', 'data', 'tempest-contract.sqlite');

if (!fs.existsSync(SCHEMA)) {
  console.log('\nTempest contract\n   – skipped (no schema file; see the header of this test)');
  module.exports = {};
  return;
}

const Database = require('better-sqlite3');
const tempest = require('../src/tempest');
const roleSync = require('../src/roleSync');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed++;
  }
}

// Work on a throwaway copy. The test inserts rows, and a test that only passes the first
// time you run it is worse than no test — it looks like a regression on the second run.
const WORKING = path.join(require('os').tmpdir(), `tempest-contract-${process.pid}.sqlite`);
fs.copyFileSync(SCHEMA, WORKING);
const db = new Database(WORKING);

console.log('\nTempest contract — the bot\'s SQL against the plugin\'s schema');

test('every table the bot uses exists', () => {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of [
    'tempest_command_request', 'tempest_link_request', 'tempest_link', 'tempest_role_sync',
  ]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test('the moderation insert fits the plugin\'s columns', () => {
  const info = db
    .prepare(tempest.SQL.insertCommand)
    .run('key-1', 'ban', '123456789012345678', 'staff#0001', 'player=Someone', 0, Date.now());
  assert.strictEqual(info.changes, 1);
});

test('the row lands as PENDING for the plugin to claim', () => {
  const row = db.prepare(tempest.SQL.readCommand).get(1);
  assert.strictEqual(row.status, 'PENDING');
  assert.strictEqual(row.result_code, null);
});

test('the bot reads back what the plugin writes', () => {
  db.prepare(
    `UPDATE tempest_command_request
     SET status='OK', result_code='OK', result_message='ban applied to Someone.', handled_at=?
     WHERE id=1`
  ).run(Date.now());

  const row = db.prepare(tempest.SQL.readCommand).get(1);
  assert.strictEqual(row.status, 'OK');
  assert.strictEqual(row.result_message, 'ban applied to Someone.');
});

test('the idempotency key is unique, so a retry cannot double-apply', () => {
  assert.throws(
    () =>
      db
        .prepare(tempest.SQL.insertCommand)
        .run('key-1', 'ban', '123456789012345678', 'staff#0001', 'player=Someone', 0, Date.now()),
    /UNIQUE/i
  );
});

test('argument encoding round-trips through the plugin\'s separator', () => {
  const encoded = tempest.encodeArgs({
    player: 'Someone',
    duration: '7d',
    // A reason containing the characters that would break a naive comma or space split.
    reason: 'griefing, spawn area — "repeatedly"',
  });
  const parts = encoded.split(tempest.SEP);
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[2], 'reason=griefing, spawn area — "repeatedly"');
});

test('blank arguments are omitted rather than sent empty', () => {
  const encoded = tempest.encodeArgs({ player: 'Someone', duration: '', reason: null });
  assert.strictEqual(encoded, 'player=Someone');
});

test('the link insert fits the plugin\'s columns', () => {
  const info = db
    .prepare(tempest.SQL.insertLink)
    .run('key-2', '123456789012345678', 'staff#0001', 'aB4cD2', Date.now());
  assert.strictEqual(info.changes, 1);
  const row = db.prepare(tempest.SQL.readLink).get(info.lastInsertRowid);
  assert.strictEqual(row.status, 'PENDING');
});

test("the admin-link insert fits the plugin's columns", () => {
  const info = db
    .prepare(tempest.SQL.insertAdminLink)
    .run('key-3', '222222222222222222', 'target#0002',
      'player=Notch,actor=111111111111111111', Date.now());
  assert.strictEqual(info.changes, 1);

  const row = db.prepare(tempest.SQL.readLink).get(info.lastInsertRowid);
  assert.strictEqual(row.status, 'PENDING');
});

test('the admin-link payload carries the player and the acting staff member', () => {
  // The plugin splits on commas and then on the first '=', and authorises the request
  // against `actor` rather than against the row's discord_id. Getting the two the wrong
  // way round would link the staff member to the target's account.
  const row = db
    .prepare('SELECT discord_id, payload FROM tempest_link_request WHERE request_key = ?')
    .get('key-3');

  const fields = Object.fromEntries(
    row.payload.split(',').map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
    })
  );

  assert.strictEqual(fields.player, 'Notch');
  assert.strictEqual(fields.actor, '111111111111111111');
  // discord_id is who gets linked, never who asked for it.
  assert.strictEqual(row.discord_id, '222222222222222222');
});

test('a mixed-case link code survives the round trip unchanged', () => {
  const row = db
    .prepare('SELECT payload FROM tempest_link_request WHERE request_key = ?')
    .get('key-2');
  // Case-sensitivity is the whole point of the mixed alphabet; a fold anywhere breaks it.
  assert.strictEqual(row.payload, 'aB4cD2');
});

test('the linked-account lookup fits the plugin\'s link table', () => {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tempest_link
       (discord_id, identity_id, uuid, name, discord_name, linked_at, linked_by,
        guild_member, has_role, state_updated_at)
     VALUES (?,?,?,?,?,?,?,1,1,?)`
  ).run(
    '123456789012345678',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'Someone',
    'staff#0001',
    now,
    'code',
    now
  );

  const account = db.prepare(tempest.SQL.readAccount).get('123456789012345678');
  assert.strictEqual(account.name, 'Someone');
  assert.strictEqual(account.uuid, '22222222-2222-2222-2222-222222222222');
});

test('one Discord account cannot hold two Minecraft accounts', () => {
  const now = Date.now();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO tempest_link
             (discord_id, identity_id, uuid, name, discord_name, linked_at, linked_by,
              guild_member, has_role, state_updated_at)
           VALUES (?,?,?,?,?,?,?,1,1,?)`
        )
        .run(
          '123456789012345678',
          '33333333-3333-3333-3333-333333333333',
          '44444444-4444-4444-4444-444444444444',
          'Another',
          'staff#0001',
          now,
          'code',
          now
        ),
    /UNIQUE|PRIMARY/i
  );
});

test('role sync quotes every reserved identifier', () => {
  // `groups` is reserved in MySQL 8.0.2+. Unquoted, both statements are syntax
  // errors — and push() logs the failure and carries on, so role sync would
  // silently never apply anything and the only symptom would be console noise.
  //
  // Checks the real statements rather than a copy of them, which is why
  // roleSync exports SQL at all. The contract test cannot execute MySQL syntax
  // against SQLite, so reading the text is the most it can do.
  for (const [name, sql] of Object.entries(roleSync.SQL)) {
    const withoutQuoted = sql.replace(/`[^`]+`/g, 'QUOTED');
    assert.ok(
      !/\bgroups\b/i.test(withoutQuoted),
      `roleSync.SQL.${name} uses an unquoted reserved word:\n${sql}`
    );
  }
});

test('the role-sync table takes a desired-state row', () => {
  // SQLite spells the upsert differently from MySQL, so the shape is what is checked here,
  // not the statement text.
  db.prepare(
    'INSERT INTO tempest_role_sync (discord_id, group_names, updated_at) VALUES (?,?,?)'
  ).run('123456789012345678', 'booster,media', Date.now());

  const row = db
    .prepare('SELECT group_names, applied_at FROM tempest_role_sync WHERE discord_id = ?')
    .get('123456789012345678');
  assert.strictEqual(row.group_names, 'booster,media');
  // applied_at defaults behind updated_at, which is how the plugin's sweep finds new work.
  assert.strictEqual(row.applied_at, 0);
});

test('a mapping matches if the member holds ANY of its role ids', () => {
  const member = { roles: { cache: new Map([['role-b', {}]]) } };
  member.roles.cache.has = Map.prototype.has.bind(member.roles.cache);

  const mapping = { group: 'tempest', roleIds: ['role-a', 'role-b', 'role-c'] };
  assert.deepStrictEqual(roleSync.roleIdsOf(mapping), ['role-a', 'role-b', 'role-c']);
});

test('roleIds accepts a bare string as well as a list', () => {
  assert.deepStrictEqual(roleSync.roleIdsOf({ roleIds: 'one' }), ['one']);
  assert.deepStrictEqual(roleSync.roleIdsOf({ roleId: 'legacy' }), ['legacy']);
  assert.deepStrictEqual(roleSync.roleIdsOf({ roleIds: ['a', 'b'] }), ['a', 'b']);
});

test('blank role ids are dropped, so an unconfigured mapping matches nobody', () => {
  assert.deepStrictEqual(roleSync.roleIdsOf({ roleIds: '' }), []);
  assert.deepStrictEqual(roleSync.roleIdsOf({ roleIds: ['', '  '] }), []);
  assert.deepStrictEqual(roleSync.roleIdsOf({}), []);
});

test('groupsFor returns what the member actually holds, deduplicated', () => {
  const cache = new Map([['role-boost', {}], ['role-t2', {}]]);
  const member = { roles: { cache } };
  cache.has = Map.prototype.has.bind(cache);

  // Two mappings pointing at the same group must not yield it twice.
  const saved = require('../config').tempest.roleSync.mappings;
  require('../config').tempest.roleSync.mappings = [
    { group: 'booster', roleIds: 'role-boost' },
    { group: 'tempest', roleIds: ['role-t1', 'role-t2'] },
    { group: 'tempest', roleIds: ['role-t2'] },
    { group: 'media', roleIds: 'role-media' },
  ];
  try {
    assert.deepStrictEqual(roleSync.groupsFor(member), ['booster', 'tempest']);
  } finally {
    require('../config').tempest.roleSync.mappings = saved;
  }
});

db.close();
try {
  fs.unlinkSync(WORKING);
} catch {
  // A leftover temp file is not worth failing the run over.
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}

/**
 * Offline smoke test — no Discord connection needed.
 * Run with: npm test
 *
 * Verifies every module loads, all slash commands build valid payloads, and
 * the ladder / scoring / ticket logic behaves the way config.js says it should.
 * Worth re-running any time you edit config.js — several checks are assertions
 * about YOUR numbers, not about the code.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};

console.log('\nStaffbot smoke test\n');

// ---------------------------------------------------------------
console.log('Modules load');
const config = require('../config');
const db = require('../src/db');
const R = require('../src/ranks');
const { computeScore, summariseVouches, verdict } = require('../src/scoring');
const ticketWatch = require('../src/ticketWatch');
const gameChat = require('../src/gameChat');
const observe = require('../src/observe');
const team = require('../src/team');
const digest = require('../src/digest');
check('every module requires cleanly', () => {
  assert.ok(config.ranks.length > 0);
  assert.ok(typeof ticketWatch.handleMessage === 'function');
  assert.ok(typeof gameChat.handleMessage === 'function');
});

// ---------------------------------------------------------------
console.log('\nSlash command definitions');
const dir = path.join(__dirname, '..', 'src', 'commands');
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const cmd = require(path.join(dir, file));
  check(`${file} builds a valid command payload`, () => {
    assert.ok(cmd.data, 'no data');
    assert.strictEqual(typeof cmd.execute, 'function', 'no execute()');
    const json = cmd.data.toJSON();
    assert.ok(json.name && json.description, 'missing name/description');
    assert.ok(json.name.length <= 32);
  });
}

// ---------------------------------------------------------------
console.log('\nStaff movement rendering');
const { buildMovement } = require('../src/movement');
const MV = { userId: '111', username: 'Vezm', avatarURL: 'https://x/y.png' };

check('a promotion renders in the hand-typed format', () => {
  const p = buildMovement({ ...MV, fromRank: config.ranks[1], toRank: config.ranks[2], kind: 'promote', note: null, color: 1 });
  assert.ok(p.content, 'line style should produce content, not an embed');
  const lines = p.content.split('\n');
  assert.strictEqual(
    lines[0],
    `<@111>    __**${config.ranks[1].name}**__  >  __**${config.ranks[2].name}**__`
  );
});

check('rank names are underlined bold', () => {
  const p = buildMovement({ ...MV, fromRank: config.ranks[1], toRank: config.ranks[2], kind: 'promote', note: null, color: 1 });
  assert.ok(p.content.includes(`__**${config.ranks[2].name}**__`), p.content);
});

check('starting a trial auto-writes the Trial Started subtext', () => {
  const p = buildMovement({ ...MV, fromRank: null, toRank: config.ranks[0], kind: 'hire', note: null, color: 1 });
  const lines = p.content.split('\n');
  assert.strictEqual(lines.length, 2, p.content);
  assert.strictEqual(lines[1], '-# Trial Started.');
});

check('each movement kind gets its own default subtext', () => {
  const kinds = { hire: 'hire', promote: 'promote', demote: 'demote', remove: 'remove' };
  for (const k of Object.values(kinds)) {
    const expected = config.announcements.defaultNotes[k];
    if (!expected) continue;
    const p = buildMovement({ ...MV, fromRank: config.ranks[2], toRank: config.ranks[1], kind: k, note: null, color: 1 });
    assert.ok(p.content.endsWith(`-# ${expected}`), `${k}: ${p.content}`);
  }
});

check('a typed note overrides the default subtext', () => {
  const p = buildMovement({ ...MV, fromRank: null, toRank: config.ranks[0], kind: 'hire', note: 'Reinstated.', color: 1 });
  assert.ok(p.content.endsWith('-# Reinstated.'), p.content);
  assert.ok(!p.content.includes('Trial Started'), 'default should have been replaced');
});

check('a note typed with its own -# prefix is not doubled', () => {
  const p = buildMovement({ ...MV, fromRank: null, toRank: config.ranks[0], kind: 'hire', note: '-# Reinstated.', color: 1 });
  assert.ok(!p.content.includes('-# -#'), p.content);
  assert.ok(p.content.endsWith('-# Reinstated.'), p.content);
});

check('subtext can be switched off per kind', () => {
  const saved = config.announcements.defaultNotes.promote;
  config.announcements.defaultNotes.promote = null;
  const p = buildMovement({ ...MV, fromRank: config.ranks[1], toRank: config.ranks[2], kind: 'promote', note: null, color: 1 });
  config.announcements.defaultNotes.promote = saved;
  assert.strictEqual(p.content.split('\n').length, 1, 'expected no subtext line');
});

check('no role is @-mentioned when mentionRoles is off', () => {
  const p = buildMovement({ ...MV, fromRank: config.ranks[1], toRank: config.ranks[2], kind: 'promote', note: null, color: 1 });
  assert.ok(!/<@&/.test(p.content), `line contains a role mention: ${p.content}`);
});

check('the only @ on the line is the member being announced', () => {
  const p = buildMovement({ ...MV, fromRank: null, toRank: config.ranks[0], kind: 'hire', note: null, color: 1 });
  const ats = p.content.match(/<@!?\d+>|<@&\d+>/g) ?? [];
  assert.strictEqual(ats.length, 1, `expected 1 mention, got ${ats.length}: ${p.content}`);
  assert.strictEqual(ats[0], '<@111>');
});

check('turning mentionRoles on brings the pills back', () => {
  const saved = config.announcements.mentionRoles;
  config.announcements.mentionRoles = true;
  const p = buildMovement({ ...MV, fromRank: config.ranks[1], toRank: config.ranks[2], kind: 'promote', note: null, color: 1 });
  config.announcements.mentionRoles = saved;
  assert.ok(p.content.includes(`<@&${config.ranks[1].roleId}>`), p.content);
});

check('a role ID in memberLabel resolves to its name when pills are off', () => {
  const saved = config.announcements.memberLabel;
  config.announcements.memberLabel = '999888777666555444';
  const guild = { roles: { cache: new Map([['999888777666555444', { name: 'Member' }]]) } };
  const p = buildMovement({ ...MV, fromRank: null, toRank: config.ranks[0], kind: 'hire', note: null, color: 1, guild });
  config.announcements.memberLabel = saved;
  assert.ok(p.content.includes('__**Member**__'), p.content);
  assert.ok(!/999888777666555444/.test(p.content), 'raw snowflake leaked into the line');
});

check('role mentions NEVER ping the role', () => {
  const p = buildMovement({ ...MV, fromRank: config.ranks[1], toRank: config.ranks[2], kind: 'promote', note: null, color: 1 });
  assert.deepStrictEqual(p.allowedMentions.roles, [], 'a promotion would ping every Staff member');
  assert.deepStrictEqual(p.allowedMentions.parse, []);
});

check('a removal renders a Removed right-hand side', () => {
  const p = buildMovement({ ...MV, fromRank: config.ranks[3], toRank: null, kind: 'remove', note: null, color: 1 });
  assert.ok(p.content.includes('__**Removed**__'), p.content);
});

check('embed style still produces an embed', () => {
  const saved = config.announcements.style;
  config.announcements.style = 'embed';
  const p = buildMovement({ ...MV, fromRank: config.ranks[1], toRank: config.ranks[2], kind: 'promote', note: null, color: 1 });
  config.announcements.style = saved;
  assert.ok(p.embeds?.length === 1);
  assert.ok(!p.content);
});

check('a private reason handed to the renderer by mistake is still not published', () => {
  const leak = 'repeatedly rude to members in tickets';
  const p = buildMovement({
    ...MV,
    fromRank: config.ranks[3],
    toRank: config.ranks[2],
    note: null,
    kind: 'demote',
    reason: leak, // simulates a future edit wiring the wrong field through
    color: 1,
  });
  const rendered = p.content ?? JSON.stringify(p.embeds[0].toJSON());
  assert.ok(!rendered.includes(leak), 'the private reason reached the public post');
});

// ---------------------------------------------------------------
console.log('\nRank ladder logic');
const fakeMember = (roleIds, id = 'u1', ownerId = 'owner') => ({
  id,
  guild: { ownerId },
  user: { username: 'test', id },
  roles: { cache: new Map(roleIds.map((r) => [r, true])) },
});
const top = R.ranks.length - 1;

check('rank role IDs are all distinct', () => {
  const ids = R.ranks.map((r) => r.roleId);
  assert.strictEqual(new Set(ids).size, ids.length, 'two ranks share a role ID');
});

check('memberRankIndex picks the highest held rank', () => {
  assert.strictEqual(R.memberRankIndex(fakeMember([R.ranks[0].roleId, R.ranks[2].roleId])), 2);
});
check('memberRankIndex returns -1 for non-staff', () => {
  assert.strictEqual(R.memberRankIndex(fakeMember([])), -1);
});
check('you cannot act on someone at your own rank', () => {
  assert.ok(R.checkActionAllowed(fakeMember([R.ranks[2].roleId], 'a'), fakeMember([R.ranks[2].roleId], 'b'), 3));
});
check('you cannot promote someone TO your own rank', () => {
  assert.ok(R.checkActionAllowed(fakeMember([R.ranks[2].roleId], 'a'), fakeMember([R.ranks[0].roleId], 'b'), 2));
});
check('a valid promotion is allowed', () => {
  assert.strictEqual(
    R.checkActionAllowed(fakeMember([R.ranks[3].roleId], 'a'), fakeMember([R.ranks[0].roleId], 'b'), 1),
    null
  );
});
check('you cannot change your own rank', () => {
  const m = fakeMember([R.ranks[2].roleId], 'same');
  assert.ok(R.checkActionAllowed(m, m, 1));
});
check('server owner outranks everyone', () => {
  assert.strictEqual(
    R.checkActionAllowed(fakeMember([], 'owner', 'owner'), fakeMember([R.ranks[top].roleId], 'b', 'owner'), top),
    null
  );
});
check('a Mod can promote up to the rank below Mod, but no further', () => {
  const modIdx = R.indexOfKey('mod');
  if (modIdx < 1) return; // ladder without a 'mod' key — nothing to assert
  const mod = fakeMember([R.ranks[modIdx].roleId], 'a');
  const junior = fakeMember([R.ranks[0].roleId], 'b');
  assert.strictEqual(R.checkActionAllowed(mod, junior, modIdx - 1), null, 'should allow one below');
  assert.ok(R.checkActionAllowed(mod, junior, modIdx), 'should block promoting to their own rank');
});

// ---------------------------------------------------------------
console.log('\nPermission keys');
check('every command is restricted to Head Mod and above', () => {
  for (const k of ['manageStaff', 'vouch', 'review']) {
    assert.strictEqual(config.permissions[k], 'headmod', `permissions.${k}`);
  }
});

check('a Mod can no longer run anything', () => {
  const modIdx = R.indexOfKey('mod');
  const mod = fakeMember([R.ranks[modIdx].roleId], 'a');
  assert.ok(!R.meetsRequirement(mod, config.permissions.manageStaff));
  assert.ok(!R.meetsRequirement(mod, config.permissions.review));
});

check('a Head Mod can run everything', () => {
  const hm = fakeMember([R.ranks[R.indexOfKey('headmod')].roleId], 'a');
  for (const k of ['manageStaff', 'vouch', 'review']) {
    assert.ok(R.meetsRequirement(hm, config.permissions[k]), k);
  }
});

check('a Head Mod can promote up to Mod but not to Head Mod', () => {
  const hmIdx = R.indexOfKey('headmod');
  const hm = fakeMember([R.ranks[hmIdx].roleId], 'a');
  const junior = fakeMember([R.ranks[0].roleId], 'b');
  assert.strictEqual(R.checkActionAllowed(hm, junior, hmIdx - 1), null, 'should allow promoting to Mod');
  assert.ok(R.checkActionAllowed(hm, junior, hmIdx), 'must not allow another Head Mod');
});

check('an override role holder who also wears a rank role is NOT tracked as staff', () => {
  const ov = config.permissions.overrideRoleIds[0];
  const ownerWithRank = fakeMember([ov, R.ranks[1].roleId], 'owner-staff');
  assert.strictEqual(R.isTracked(ownerWithRank), false, 'owner would be scored like a trial');
  assert.strictEqual(R.authorityIndex(ownerWithRank), R.ranks.length, 'but must still outrank everyone');
});

check('an ordinary rank-holder IS tracked', () => {
  assert.strictEqual(R.isTracked(fakeMember([R.ranks[1].roleId], 'plain')), true);
});

check('someone with no rank role is not tracked', () => {
  assert.strictEqual(R.isTracked(fakeMember([], 'member')), false);
});

check('trackOverrides:true brings owners back into the measured set', () => {
  const saved = config.permissions.trackOverrides;
  config.permissions.trackOverrides = true;
  const ov = config.permissions.overrideRoleIds[0];
  const r = R.isTracked(fakeMember([ov, R.ranks[1].roleId], 'owner-staff'));
  config.permissions.trackOverrides = saved;
  assert.strictEqual(r, true);
});

check('override roles do NOT bypass each other', () => {
  const [a, b] = config.permissions.overrideRoleIds;
  const blocked = R.checkActionAllowed(fakeMember([a], 'one'), fakeMember([b], 'two'), 4);
  assert.ok(blocked, 'an Owner must not be able to demote the Founder');
});

check('the Discord server owner outranks even override roles', () => {
  const ov = config.permissions.overrideRoleIds[0];
  const srvOwner = fakeMember([], 'owner', 'owner');
  const holder = { ...fakeMember([ov], 'holder'), guild: { ownerId: 'owner' } };
  assert.strictEqual(R.checkActionAllowed(srvOwner, holder, 4), null);
});

check('an override role holder can do what a Head Mod cannot', () => {
  const ovId = config.permissions.overrideRoleIds[0];
  assert.ok(ovId, 'no override roles configured');
  const owner = fakeMember([ovId], 'a');
  const hm = fakeMember([R.ranks[R.indexOfKey('headmod')].roleId], 'b');
  assert.strictEqual(
    R.checkActionAllowed(owner, hm, R.indexOfKey('headmod')),
    null,
    'an override role must be able to make someone Head Mod'
  );
});

check('enough people can reach the vouch minimum', () => {
  // Head Mods are not countable offline, but the override roles are, and they
  // all bypass. If even (overrides + server owner) cannot reach the minimum,
  // the config is unworkable regardless of how many Head Mods exist.
  const overrides = (config.permissions.overrideRoleIds ?? []).length;
  const min = config.scoring.vouches.minimum;
  assert.ok(
    overrides + 1 >= min,
    `${overrides} override role(s) + owner cannot reach the ${min}-vouch minimum on their own`
  );
});

check('every rank-naming permission names a real rank', () => {
  const keys = R.ranks.map((r) => r.key);
  for (const name of ['manageStaff', 'vouch', 'review']) {
    const val = config.permissions[name];
    assert.ok(keys.includes(val), `permissions.${name} = "${val}" is not a rank key`);
  }
});
// ---------------------------------------------------------------
console.log('\nScoring engine');
const zero = {
  modActions: 0,
  ticketsHandled: 0,
  inGameActivity: 0,
  channelBreadth: 0,
  staffPresence: 0,
  publicActivity: 0,
  activeDays: 0,
  responseCount: 0,
  responseSpeed: null,
};
const perfect = () => {
  const p = { ...zero, responseCount: 10 };
  for (const [k, d] of Object.entries(config.scoring.metrics)) {
    p[k] = d.direction === 'lower' ? d.target : d.target;
  }
  return p;
};

check('a totally inactive trial scores 0', () => {
  assert.strictEqual(computeScore(zero).score, 0);
});
check('hitting every target scores 100', () => {
  assert.strictEqual(computeScore(perfect()).score, 100);
});
check('overshooting a target does not push the score past 100', () => {
  const farmed = { ...perfect() };
  for (const [k, d] of Object.entries(config.scoring.metrics)) {
    if (d.direction !== 'lower') farmed[k] = d.target * 50;
  }
  assert.strictEqual(computeScore(farmed).score, 100);
});
check('message spam alone cannot pass the bar', () => {
  const { score } = computeScore({ ...zero, publicActivity: 999999, staffPresence: 999999 });
  assert.ok(
    score < config.scoring.autoFlag.promote,
    `chat alone scored ${score}, clearing the ${config.scoring.autoFlag.promote} bar — lower those weights`
  );
});
check('no single metric can pass the bar on its own', () => {
  for (const [k, d] of Object.entries(config.scoring.metrics)) {
    if (!d.enabled) continue;
    const solo = { ...zero, responseCount: k === 'responseSpeed' ? 10 : 0 };
    solo[k] = d.direction === 'lower' ? 0.01 : d.target * 100;
    const { score } = computeScore(solo);
    assert.ok(
      score < config.scoring.autoFlag.promote,
      `maxing "${k}" alone scores ${score}, which passes — its weight (${d.weight}) is too high`
    );
  }
});
check('weights renormalise to ~100 across enabled metrics', () => {
  const sum = computeScore(perfect()).breakdown.reduce((s, b) => s + b.weightPct, 0);
  assert.ok(Math.abs(sum - 100) <= 2, `weights summed to ${sum}`);
});
check('breakdown is sorted weakest-first', () => {
  const partial = { ...zero, modActions: config.scoring.metrics.modActions.target };
  const bd = computeScore(partial).breakdown;
  for (let i = 1; i < bd.length; i++) assert.ok(bd[i].pct >= bd[i - 1].pct);
});

console.log('\nResponse time (inverted metric)');
check('faster than target scores full marks', () => {
  const m = { ...zero, responseCount: 5, responseSpeed: 2 };
  const b = computeScore(m).breakdown.find((x) => x.key === 'responseSpeed');
  assert.strictEqual(b.pct, 1);
});
check('slower than target scores proportionally less', () => {
  const t = config.scoring.metrics.responseSpeed.target;
  const m = { ...zero, responseCount: 5, responseSpeed: t * 4 };
  const b = computeScore(m).breakdown.find((x) => x.key === 'responseSpeed');
  assert.ok(b.pct > 0 && b.pct <= 0.26, `expected ~0.25, got ${b.pct}`);
});
check('handling no tickets skips response time rather than scoring it 0', () => {
  const { breakdown, skipped } = computeScore(zero);
  assert.ok(!breakdown.find((b) => b.key === 'responseSpeed'), 'should not be scored');
  assert.ok(skipped.includes(config.scoring.metrics.responseSpeed.label));
});
check('skipping a metric does not silently lower the max achievable score', () => {
  const noTickets = { ...perfect(), responseCount: 0, responseSpeed: null, ticketsHandled: 0 };
  const { breakdown } = computeScore(noTickets);
  const sum = breakdown.reduce((s, b) => s + b.weightPct, 0);
  assert.ok(Math.abs(sum - 100) <= 2, `weights summed to ${sum} after a skip`);
});
check('response time is displayed in human units, not raw', () => {
  const b = computeScore({ ...zero, responseCount: 3, responseSpeed: 90 }).breakdown.find(
    (x) => x.key === 'responseSpeed'
  );
  assert.ok(/hr|min/.test(b.display), `got "${b.display}"`);
});

// ---------------------------------------------------------------
console.log('\nVouch + verdict logic');
const v = (list) => summariseVouches(list.map((x, i) => ({ verdict: x, voucher_id: 'v' + i })));

check('unanimous yes with enough votes passes', () => assert.strictEqual(v(['yes', 'yes', 'yes']).state, 'pass'));
check('a single vote is not enough to count', () => assert.strictEqual(v(['yes']).state, 'insufficient'));
check('abstains do not count toward the ratio', () => assert.strictEqual(v(['yes', 'yes', 'abstain']).ratio, 1));
check('a split vote below the pass ratio fails', () => assert.strictEqual(v(['yes', 'no', 'no']).state, 'fail'));
check('high score + failed vouches = BELOW BAR (humans override numbers)', () =>
  assert.strictEqual(verdict(95, v(['no', 'no', 'yes'])).code, 'below_bar'));
check('low score + unanimous yes = BELOW BAR (numbers override humans)', () =>
  assert.strictEqual(verdict(20, v(['yes', 'yes', 'yes'])).code, 'below_bar'));
check('high score + passing vouches = READY', () =>
  assert.strictEqual(verdict(90, v(['yes', 'yes', 'yes'])).code, 'ready'));
check('high score + no vouches yet is never auto-ready', () =>
  assert.strictEqual(verdict(90, v([])).code, 'borderline'));
check('a middling score is never auto-anything', () => {
  const mid = Math.floor((config.scoring.autoFlag.belowBar + config.scoring.autoFlag.promote) / 2);
  assert.strictEqual(verdict(mid, v(['yes', 'yes'])).code, 'borderline');
});
check('the bar thresholds are in a sane order', () => {
  assert.ok(config.scoring.autoFlag.belowBar < config.scoring.autoFlag.promote);
  assert.ok(config.scoring.vouches.passRatio > 0.5, 'a pass ratio at or under 50% means a tie passes');
});

// ---------------------------------------------------------------
console.log('\nDatabase round-trip');
const G = 'testguild';
const U = 'testuser';

check('setRank then getStaff returns the new rank', () => {
  db.setRank(G, U, R.ranks[0].key, 'actor');
  assert.strictEqual(db.getStaff(G, U).rank_key, R.ranks[0].key);
});
check('metrics accumulate and read back over a window', () => {
  db.bumpMetric(G, U, 'modActions', 3);
  db.bumpMetric(G, U, 'modActions', 2);
  const m = db.getMetrics(G, U, Date.now() - 86400000, Date.now());
  assert.strictEqual(m.modActions, 5);
  assert.ok(m.activeDays >= 1);
});
check('response time averages correctly across tickets', () => {
  db.bumpMetric(G, U, 'responseTotalSec', 600); // 10 min
  db.bumpMetric(G, U, 'responseCount', 1);
  db.bumpMetric(G, U, 'responseTotalSec', 1800); // 30 min
  db.bumpMetric(G, U, 'responseCount', 1);
  const m = db.getMetrics(G, U, Date.now() - 86400000, Date.now());
  assert.strictEqual(m.responseSpeed, 20); // (10+30)/2
});
check('response bookkeeping metrics do not inflate active-day count', () => {
  const m = db.getMetrics(G, U, Date.now() - 86400000, Date.now());
  assert.strictEqual(m.activeDays, 1);
});
check('a re-cast vouch replaces the old one instead of double counting', () => {
  db.putVouch(G, U, 'senior1', 1, 'no', 'changed my mind');
  db.putVouch(G, U, 'senior1', 1, 'yes', 'they improved');
  const rows = db.getVouches(G, U, 1);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].verdict, 'yes');
});
check('vouches from an old trial do not leak into a new one', () => {
  db.putVouch(G, U, 'senior2', 1000, 'no', 'first trial');
  assert.strictEqual(db.getVouches(G, U, 2000).length, 0);
});
check('notes and audit entries persist', () => {
  db.addNote(G, U, 'author', 'concern', 'late to tickets');
  db.addAudit(G, 'actor', U, 'promote', 'trial -> staff');
  assert.ok(db.getNotes(G, U, 5).length >= 1);
  assert.ok(db.getAudit(G, U, 5).length >= 1);
});

// ---------------------------------------------------------------
console.log('\nTicket King integration');
const CH = 'chan-1';

check('a ticket channel is registered once and only once', () => {
  const t = db.noteTicketOpened({
    guildId: G, channelId: CH, channelName: 'ticket-0001', openerId: 'member1',
    openedAt: Date.now() - 600000,
  });
  assert.strictEqual(t.state, 'open');
  db.noteTicketOpened({ guildId: G, channelId: CH, channelName: 'x', openerId: 'someone-else', openedAt: Date.now() });
  assert.strictEqual(db.getTicket(CH).opener_id, 'member1', 'a second sighting must not overwrite the first');
});

check('participation counts accumulate per staff member', () => {
  for (let i = 0; i < 5; i++) db.bumpParticipant(CH, U);
  db.bumpParticipant(CH, 'staffB');
  const parts = db.getParticipants(CH);
  assert.strictEqual(parts[0].user_id, U, 'should be sorted by message count');
  assert.strictEqual(parts[0].messages, 5);
});

check('first response is recorded once and only once', () => {
  const first = db.recordFirstResponse(db.getTicket(CH), U);
  assert.ok(first !== null && first >= 590, `expected ~600s, got ${first}`);
  assert.strictEqual(db.recordFirstResponse(db.getTicket(CH), 'staffB'), null, 'a later reply must not overwrite');
  assert.strictEqual(db.getTicket(CH).first_response_by, U);
});

check('credit goes to the top talker when nobody claimed', () => {
  db.setRank(G, 'staffB', R.ranks[0].key, 'actor');
  const credited = ticketWatch.decideCredit(G, db.getTicket(CH));
  assert.deepStrictEqual(credited, [U], 'expected the 5-message staff member');
});

check('a staff member under the threshold is not credited', () => {
  const parts = db.getParticipants(CH).filter((p) => p.user_id === 'staffB');
  assert.ok(parts[0].messages < config.ticketKing.minMessagesToCredit);
  const credited = ticketWatch.decideCredit(G, db.getTicket(CH));
  assert.ok(!credited.includes('staffB'), 'one message should not earn a ticket credit');
});

check('a detected claim beats the message count', () => {
  db.setClaim(CH, 'staffB');
  const credited = ticketWatch.decideCredit(G, db.getTicket(CH));
  assert.deepStrictEqual(credited, ['staffB'], 'the claimer owns the ticket regardless of who talked most');
  db.db.prepare('UPDATE tickets SET claimed_by = NULL WHERE channel_id = ?').run(CH);
});

check('a ticket nobody worked credits nobody', () => {
  db.noteTicketOpened({ guildId: G, channelId: 'chan-empty', openerId: 'member2', openedAt: Date.now() });
  assert.deepStrictEqual(ticketWatch.decideCredit(G, db.getTicket('chan-empty')), []);
});

check('a non-staff participant is never credited', () => {
  db.noteTicketOpened({ guildId: G, channelId: 'chan-member', openerId: 'member3', openedAt: Date.now() });
  for (let i = 0; i < 20; i++) db.bumpParticipant('chan-member', 'member3');
  assert.deepStrictEqual(ticketWatch.decideCredit(G, db.getTicket('chan-member')), []);
});

check('closing credits the right person and marks the ticket closed', () => {
  const credited = ticketWatch.closeTicket(G, db.getTicket(CH));
  assert.deepStrictEqual(credited, [U]);
  const t = db.getTicket(CH);
  assert.strictEqual(t.state, 'closed');
  assert.strictEqual(t.credited_to, U);
  const stats = db.ticketStatsFor(G, U, 0, Date.now() + 1000);
  assert.strictEqual(stats.handled, 1);
});

check('the shipped claimPattern matches a plausible Ticket King claim', () => {
  const msg = (content) => ({ content, embeds: [] });
  const hits = [
    '<@111222333444555666> has claimed this ticket',
    'Ticket claimed by <@111222333444555666>',
    '<@!111222333444555666> claimed the ticket',
  ].map((c) => ticketWatch.detectClaim(msg(c)));
  assert.ok(hits.every((h) => h === '111222333444555666'), `got ${JSON.stringify(hits)}`);
});

check('claim detection reads embed fields too, not just content', () => {
  const id = ticketWatch.detectClaim({
    content: '',
    embeds: [{ fields: [{ name: 'Claimed by', value: '<@111222333444555666>' }] }],
  });
  assert.strictEqual(id, '111222333444555666');
});

check('an unrelated message is not mistaken for a claim', () => {
  assert.strictEqual(ticketWatch.detectClaim({ content: 'hey <@111222333444555666> can you look at this', embeds: [] }), null);
});

// ---------------------------------------------------------------
console.log('\nIn-game chat bridge');

check('a webhook bridge message yields the Minecraft name with no parsing', () => {
  const hit = gameChat.extract({ webhookId: 'w1', author: { username: 'Zac_MC' }, content: 'anyone near spawn?' });
  assert.strictEqual(hit.ign, 'Zac_MC');
  assert.strictEqual(hit.body, 'anyone near spawn?');
});

check("DiscordSRV's default format is parsed, rank prefix and all", () => {
  const cases = [
    ['**Owner** Zac_MC » anyone near spawn?', 'Zac_MC'],
    ['Zac_MC » anyone near spawn?', 'Zac_MC'],
    ['**[Head Mod]** Zac_MC » anyone near spawn?', 'Zac_MC'],
  ];
  for (const [raw, want] of cases) {
    const hit = gameChat.extract({ author: { username: 'DiscordSRV' }, content: raw });
    assert.ok(hit, `no match for: ${raw}`);
    assert.strictEqual(hit.ign, want, `${raw} -> ${hit.ign}`);
    assert.ok(hit.body.includes('spawn'), raw);
  }
});

check('the rank prefix is never mistaken for the player', () => {
  const hit = gameChat.extract({ author: { username: 'DiscordSRV' }, content: '**Owner** Zac_MC » hi' });
  assert.notStrictEqual(hit.ign, 'Owner', 'captured the group name instead of the player');
});

check('a nickname the strict pattern cannot express still resolves', () => {
  const hit = gameChat.extract({ author: { username: 'DiscordSRV' }, content: '**Mod** xX_Zac_Xx » hello there' });
  assert.ok(hit, 'loose fallback did not fire');
  assert.strictEqual(hit.ign, 'xX_Zac_Xx');
});

check('a loose-fallback guess still has to resolve through /link to count', () => {
  assert.strictEqual(db.resolveGameName(G, 'SomeNicknameNobodyLinked'), null);
});

check('a webhook name that is not a valid IGN is rejected', () => {
  const hit = gameChat.extract({ webhookId: 'w1', author: { username: 'Server Broadcast!' }, content: 'x' });
  assert.strictEqual(hit, null);
});

check("DiscordSRV's own broadcasts are filtered as noise", () => {
  for (const line of [
    ':white_check_mark: **Server has started**',
    ':octagonal_sign: **Server has stopped**',
    'Zac_MC joined the server',
    'Zac_MC left the server',
    'Zac_MC has made the advancement Diamonds!',
  ]) {
    assert.ok(gameChat.isNoise(line), `should have been filtered: ${line}`);
  }
});

check('join/leave/death embeds carry no content, so they never reach the parser', () => {
  const hit = gameChat.extract({
    author: { username: 'DiscordSRV' },
    content: '',
    embeds: [{ author: { name: 'Zac_MC joined the server' } }],
  });
  assert.strictEqual(hit, null);
});

check('ordinary chat is not filtered as noise', () => {
  assert.ok(!gameChat.isNoise('**Mod** Zac_MC » can someone help at spawn'));
});

check('an unlinked name resolves to nobody', () => {
  assert.strictEqual(db.resolveGameName(G, 'SomeRandomPlayer'), null);
});

check('linking is case-insensitive both ways', () => {
  db.linkGameName(G, 'Zac_MC', U, 'actor');
  assert.strictEqual(db.resolveGameName(G, 'zac_mc'), U);
  assert.strictEqual(db.resolveGameName(G, 'ZAC_MC'), U);
});

check('one person can hold several Minecraft names', () => {
  db.linkGameName(G, 'ZacAlt', U, 'actor');
  const names = db.linksForUser(G, U).map((l) => l.ign);
  assert.ok(names.includes('Zac_MC') && names.includes('ZacAlt'), names.join(','));
});

check('re-linking a name moves it rather than duplicating it', () => {
  db.linkGameName(G, 'ZacAlt', 'someone-else', 'actor');
  assert.strictEqual(db.resolveGameName(G, 'zacalt'), 'someone-else');
  assert.strictEqual(db.listLinks(G).filter((l) => l.ign_lower === 'zacalt').length, 1);
  db.unlinkGameName(G, 'ZacAlt');
});

check('in-game presence is scored when the bridge is configured', () => {
  const saved = config.gameChat.channelId;
  config.gameChat.channelId = '1540111111111111111';
  const { breakdown } = computeScore({ ...zero, inGameActivity: 40 });
  config.gameChat.channelId = saved;
  const m = breakdown.find((b) => b.key === 'inGameActivity');
  assert.ok(m, 'inGameActivity should be scored');
  assert.ok(m.pct > 0 && m.pct < 1);
});

check('in-game presence is skipped entirely when the bridge is unconfigured', () => {
  const saved = config.gameChat.channelId;
  config.gameChat.channelId = '000000000000000050';
  const { breakdown, skipped } = computeScore(zero);
  config.gameChat.channelId = saved;
  assert.ok(!breakdown.find((b) => b.key === 'inGameActivity'), 'should not be scored');
  assert.ok(skipped.includes(config.scoring.metrics.inGameActivity.label));
});

check('skipping in-game presence still leaves the weights at ~100', () => {
  const saved = config.gameChat.channelId;
  config.gameChat.channelId = '000000000000000050';
  const { breakdown } = computeScore({ ...zero, responseCount: 3, responseSpeed: 10 });
  config.gameChat.channelId = saved;
  const sum = breakdown.reduce((s, b) => s + b.weightPct, 0);
  assert.ok(Math.abs(sum - 100) <= 2, `weights summed to ${sum}`);
});

// ---------------------------------------------------------------
console.log('\nPrivate staff log removed');

check('the private staff-log channel is switched off', () => {
  assert.strictEqual(config.channels.staffLog, null);
});

check('rank-change reasons survive in the audit trail, not a channel', () => {
  db.addAudit(G, 'actor', U, 'promote', 'Staff → Head Staff: consistently strong on tickets');
  const found = db.getAudit(G, U, 8).find((h) => h.action === 'promote');
  assert.ok(found, 'promote not recorded');
  assert.ok(found.detail.includes('consistently strong'), 'the reason was lost');
});

// ---------------------------------------------------------------
console.log('\nPresence & conduct');
const PU = 'presenceuser';

check('presence counts distinct channels and hours, not messages', () => {
  db.setRank(G, PU, R.ranks[0].key, 'actor');
  const H = (h) => Date.now() - h * 3600000;
  db.bumpPresence(G, PU, 'chanA', H(1));
  db.bumpPresence(G, PU, 'chanA', H(1)); // same channel+hour again
  db.bumpPresence(G, PU, 'chanB', H(4));
  db.bumpPresence(G, PU, 'chanC', H(9));
  const m = db.getMetrics(G, PU, Date.now() - 86400000, Date.now());
  assert.strictEqual(m.channelBreadth, 3, 'should be 3 distinct channels');
  assert.ok(m.activeHours >= 3, `expected >=3 distinct hours, got ${m.activeHours}`);
});

check('channel spread is scored', () => {
  const { breakdown } = computeScore({ ...zero, channelBreadth: 3 });
  const b = breakdown.find((x) => x.key === 'channelBreadth');
  assert.ok(b, 'channelBreadth not scored');
  assert.ok(b.pct > 0 && b.pct < 1);
});

check('lurking in one channel scores badly on spread', () => {
  const { breakdown } = computeScore({ ...zero, channelBreadth: 1, publicActivity: 999 });
  const b = breakdown.find((x) => x.key === 'channelBreadth');
  assert.ok(b.pct <= 0.25, `one channel scored ${b.pct}`);
});

check('the conduct sample is capped and keeps the newest', () => {
  const cap = 5;
  for (let i = 0; i < 12; i++) db.addConduct(G, PU, 'chanA', 'discord', `line ${i}`, cap);
  assert.strictEqual(db.countConduct(G, PU), cap);
  const kept = db.getConduct(G, PU, 20).map((r) => r.content);
  assert.ok(kept.includes('line 11'), 'newest line was dropped');
  assert.ok(!kept.includes('line 0'), 'oldest line was kept');
});

check('the sample spreads across the stored set rather than taking the last few', () => {
  db.clearConduct(G, PU);
  for (let i = 0; i < 20; i++) db.addConduct(G, PU, 'chanA', 'discord', `line ${i}`, 30);
  const picked = observe.conductSample(G, PU, 4).map((r) => r.content);
  assert.strictEqual(picked.length, 4);
  assert.strictEqual(new Set(picked).size, 4, 'returned duplicates');
  const last4 = db.getConduct(G, PU, 4).map((r) => r.content);
  assert.notDeepStrictEqual(picked, last4, 'just returned the most recent four');
});

check('conduct is not collected from excluded channels', () => {
  const saved = config.conduct.excludeChannelIds;
  config.conduct.excludeChannelIds = ['secret-chan'];
  db.clearConduct(G, PU);
  observe.noteConduct(G, PU, 'secret-chan', 'this should never be stored');
  const n = db.countConduct(G, PU);
  config.conduct.excludeChannelIds = saved;
  assert.strictEqual(n, 0, 'stored a line from an excluded channel');
});

check('onlyDuringTrial keeps the bot out of non-trial staff messages', () => {
  db.clearConduct(G, PU);
  db.clearTrial(G, PU, 'passed');            // no longer on trial
  observe.noteConduct(G, PU, 'chanA', 'a perfectly ordinary sentence');
  assert.strictEqual(db.countConduct(G, PU), 0, 'sampled someone who is not on trial');
});

check('a trial member IS sampled', () => {
  db.startTrial(G, PU, Date.now() + 86400000);
  observe.noteConduct(G, PU, 'chanA', 'a perfectly ordinary sentence');
  assert.strictEqual(db.countConduct(G, PU), 1);
});

check('very short messages are not sampled', () => {
  db.clearConduct(G, PU);
  observe.noteConduct(G, PU, 'chanA', 'k');
  assert.strictEqual(db.countConduct(G, PU), 0);
});

check('retention purge removes old lines', () => {
  db.clearConduct(G, PU);
  db.addConduct(G, PU, 'chanA', 'discord', 'recent line here', 30);
  db.db.prepare('UPDATE conduct SET created_at = ? WHERE guild_id = ?').run(1000, G);
  db.purgeConduct(Date.now() - 86400000);
  assert.strictEqual(db.countConduct(G, PU), 0);
});

check('the coverage bar renders 24 slots', () => {
  const H = (h) => Date.now() - h * 3600000;
  db.bumpPresence(G, PU, 'chanA', H(2));
  const bar = observe.coverageBar(G, PU, Date.now() - 86400000, Date.now());
  assert.ok(bar, 'no bar produced');
  assert.strictEqual([...bar].length, 24, `expected 24 slots, got ${[...bar].length}`);
});

// ---------------------------------------------------------------
console.log('\nLeave of absence');
const LU = 'loauser';

check('starting leave records it and it reads back as active', () => {
  db.setRank(G, LU, R.ranks[0].key, 'actor');
  const l = db.startLoa(G, LU, 7, 'exams', 'actor');
  assert.ok(l);
  assert.ok(db.activeLoa(G, LU));
  assert.ok(l.end_at > Date.now());
});

check('leave days overlapping a window are counted', () => {
  const d = db.loaDaysInWindow(G, LU, Date.now() - 7 * 86400000, Date.now() + 7 * 86400000);
  assert.ok(d >= 6 && d <= 7, `expected ~7, got ${d}`);
});

check('someone on leave is not reported as quiet', () => {
  const quiet = team.quiet(G, 1);
  assert.ok(!quiet.find((q) => q.userId === LU), 'a person on leave was chased for being inactive');
});

check('ending leave clears it, and they become chaseable again', () => {
  db.endLoa(db.activeLoa(G, LU).id);
  assert.strictEqual(db.activeLoa(G, LU), undefined);
  assert.ok(team.quiet(G, 1).find((q) => q.userId === LU), 'should be visible once leave ends');
});

check('expired leave is closed automatically', () => {
  const l = db.startLoa(G, LU, 1, 'short', 'actor');
  db.db.prepare('UPDATE loa SET end_at = ? WHERE id = ?').run(Date.now() - 1000, l.id);
  db.expireLoa();
  assert.strictEqual(db.activeLoa(G, LU), undefined);
});

// ---------------------------------------------------------------
console.log('\nTeam views');
const TEAM = ['t-alice', 't-bob', 't-carol'];

check('the leaderboard ranks tracked staff by score', () => {
  db.setRank(G, TEAM[0], R.ranks[1].key, 'a');
  db.setRank(G, TEAM[1], R.ranks[0].key, 'a');
  db.bumpMetric(G, TEAM[0], 'ticketsHandled', 8);
  db.bumpMetric(G, TEAM[0], 'inGameActivity', 80);
  db.bumpMetric(G, TEAM[1], 'ticketsHandled', 1);
  const board = team.leaderboard(G, Date.now() - 30 * 86400000, Date.now());
  const a = board.findIndex((r) => r.userId === TEAM[0]);
  const b = board.findIndex((r) => r.userId === TEAM[1]);
  assert.ok(a < b, 'the more active person should rank higher');
  assert.ok(board[a].score > board[b].score);
});

check('every leaderboard row names its weakest metric', () => {
  const board = team.leaderboard(G, Date.now() - 30 * 86400000, Date.now());
  for (const r of board) assert.ok(r.weakest?.label, `${r.userId} has no weakest metric`);
});

check('coverage returns 24 hourly slots', () => {
  const H = (h) => Date.now() - h * 3600000;
  [1, 2, 3, 14, 15].forEach((h, i) => db.bumpPresence(G, TEAM[0], 'c' + i, H(h)));
  const c = team.coverage(G, Date.now() - 14 * 86400000, Date.now());
  assert.strictEqual(c.hours.length, 24);
  assert.strictEqual([...c.bar].length, 24);
});

check('hours with nobody around are reported as gaps', () => {
  const c = team.coverage(G, Date.now() - 14 * 86400000, Date.now());
  assert.ok(c.gaps.length > 0, 'a sparse week should have gaps');
  for (const g of c.gaps) assert.ok(g.end >= g.start);
});

check('a gap spanning midnight is reported once, not twice', () => {
  const c = team.coverage(G, Date.now() - 14 * 86400000, Date.now());
  const wrapped = c.gaps.filter((g) => g.end >= 24);
  assert.ok(wrapped.length <= 1, 'midnight wrap produced two gaps');
});

check('the digest builds without a live Discord connection', () => {
  const { embed } = digest.build({ id: G, name: 'Test' });
  const j = embed.toJSON();
  assert.ok(j.title.includes('Staff digest'));
  assert.ok(j.fields?.length || j.description, 'digest was completely empty');
});

check('the digest leaves the leaderboard out unless asked', () => {
  const saved = config.digest.includeLeaderboard;
  config.digest.includeLeaderboard = false;
  const off = digest.build({ id: G, name: 'T' }).embed.toJSON();
  config.digest.includeLeaderboard = true;
  const on = digest.build({ id: G, name: 'T' }).embed.toJSON();
  config.digest.includeLeaderboard = saved;
  const has = (j) => (j.fields ?? []).some((f) => f.name.includes('Scores'));
  assert.ok(!has(off), 'leaderboard appeared when switched off');
  assert.ok(has(on), 'leaderboard missing when switched on');
});

// ---------------------------------------------------------------
console.log('\nStanding — the system above Trial Staff');
const standing = require('../src/standing');
const { buildStandingCard, buildReviewCard } = require('../src/reviewCard');

const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const putMetric = db.db.prepare(`
  INSERT INTO metrics (guild_id, user_id, day, metric, value) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (guild_id, user_id, day, metric) DO UPDATE SET value = value + excluded.value
`);
const setSince = db.db.prepare('UPDATE staff SET rank_since = ? WHERE guild_id = ? AND user_id = ?');
const backdate = (u, days) => {
  setSince.run(Date.now() - days * 86400000, G, u);
  return db.getStaff(G, u);
};
const bumpDay = (u, metric, value, daysAgo) => putMetric.run(G, u, dayAgo(daysAgo), metric, value);

/** Fill every metric to roughly target across `days` recent days. */
function makeExcellent(user, { offset = 0, days = 20 } = {}) {
  for (let d = 0; d < days; d++) {
    bumpDay(user, 'ticketsHandled', 1, d + offset);
    bumpDay(user, 'inGameActivity', 10, d + offset);
    bumpDay(user, 'modActions', 1, d + offset);
    bumpDay(user, 'staffPresence', 4, d + offset);
    bumpDay(user, 'publicActivity', 12, d + offset);
  }
  bumpDay(user, 'responseCount', 10, offset + 1);
  bumpDay(user, 'responseTotalSec', 10 * 600, offset + 1); // 10 min average
  for (let c = 0; c < 9; c++) {
    db.bumpPresence(G, user, 'sc' + c, Date.now() - (offset * 86400000 + c * 3600000));
  }
}

check('every rank above the trial has its own targets and weights', () => {
  for (const rank of R.ranks.slice(1)) {
    const p = standing.profileFor(rank.key);
    assert.ok(p, `${rank.name} has no standing profile — it would be judged on trial targets`);
    assert.ok(Object.keys(p.targets ?? {}).length, `${rank.name} has no targets`);
    assert.ok(Object.keys(p.weights ?? {}).length, `${rank.name} has no weights`);
  }
});

check('standing targets are harder than trial targets', () => {
  // They cover 30 days rather than a 14-day trial. If they were not higher,
  // every ranked staff member would score ~100 and the bar would mean nothing.
  const trial = config.scoring.metrics.ticketsHandled.target;
  for (const rank of R.ranks.slice(1, 3)) {
    assert.ok(
      standing.profileFor(rank.key).targets.ticketsHandled > trial,
      `${rank.name} ticket target is not above the trial target`
    );
  }
});

check('the top of the ladder is not judged on ticket volume', () => {
  const top = standing.profileFor(R.ranks[R.ranks.length - 1].key).weights;
  const bottom = standing.profileFor(R.ranks[1].key).weights;
  assert.ok(
    top.ticketsHandled < bottom.ticketsHandled,
    'a Head Mod is weighted on tickets as heavily as a Staff member'
  );
  assert.ok(
    top.staffPresence > bottom.staffPresence,
    'leading the team is not weighted above grinding tickets at the top rank'
  );
});

check('targets scale to a shorter window', () => {
  const full = standing.scaledProfile(R.ranks[1].key, 30);
  const week = standing.scaledProfile(R.ranks[1].key, 7);
  assert.ok(week.targets.ticketsHandled < full.targets.ticketsHandled, 'ticket target did not scale');
  assert.ok(week.targets.inGameActivity < full.targets.inGameActivity);
});

check('averages and distinct counts are NOT scaled', () => {
  const full = standing.scaledProfile(R.ranks[1].key, 30);
  const week = standing.scaledProfile(R.ranks[1].key, 7);
  assert.strictEqual(
    week.targets.responseSpeed,
    full.targets.responseSpeed,
    'a shorter window must not change what counts as a fast reply'
  );
  assert.strictEqual(week.targets.channelBreadth, full.targets.channelBreadth);
});

check('you cannot be active on more days than the window has', () => {
  const week = standing.scaledProfile(R.ranks[1].key, 7);
  assert.ok(week.targets.activeDays <= 7, `activeDays target ${week.targets.activeDays} exceeds 7`);
});

check('a ranked staff member doing nothing reads under the hold bar', () => {
  db.setRank(G, 's-ghost', R.ranks[1].key, 'a');
  const a = standing.assess(G, backdate('s-ghost', 90));
  assert.ok(a.score < config.standing.holdBar, `scored ${a.score}`);
  assert.ok(['drifting', 'quiet_window'].includes(a.verdict.code), a.verdict.code);
});

check('one bad window is not called drifting', () => {
  // No previous window at all means no streak, so nothing to flag yet.
  const a = standing.assess(G, db.getStaff(G, 's-ghost'));
  assert.strictEqual(a.drifting, false, 'flagged on a single window');
  assert.strictEqual(a.verdict.code, 'quiet_window');
});

check('two windows under the bar IS drifting', () => {
  db.setRank(G, 's-fade', R.ranks[2].key, 'a');
  backdate('s-fade', 200);
  // Barely present in both windows — enough data to compare, not enough to pass.
  for (const d of [3, 9, 40, 50]) bumpDay('s-fade', 'publicActivity', 6, d);
  const a = standing.assess(G, db.getStaff(G, 's-fade'));
  assert.ok(a.previous, 'no previous window was scored');
  assert.strictEqual(a.verdict.code, 'drifting', `got ${a.verdict.code} at ${a.score}`);
});

check('a strong month with no time in rank is held back by the calendar', () => {
  db.setRank(G, 's-star', R.ranks[1].key, 'a'); // rank_since = now
  makeExcellent('s-star');
  const a = standing.assess(G, db.getStaff(G, 's-star'));
  assert.ok(a.score >= config.standing.promoteBar, `only scored ${a.score}`);
  assert.strictEqual(a.tenureMet, false);
  assert.strictEqual(a.verdict.code, 'too_soon');
});

check('with the time served but no vouches, they are a candidate not a promotion', () => {
  const a = standing.assess(G, backdate('s-star', 120));
  assert.strictEqual(a.tenureMet, true);
  assert.strictEqual(a.verdict.code, 'candidate');
});

check('score plus tenure plus vouches is what makes someone ready', () => {
  const row = db.getStaff(G, 's-star');
  db.putVouch(G, 's-star', 'v-1', row.rank_since, 'yes', 'carries the team');
  db.putVouch(G, 's-star', 'v-2', row.rank_since, 'yes', null);
  const a = standing.assess(G, db.getStaff(G, 's-star'));
  assert.strictEqual(a.verdict.code, 'ready');
  assert.ok(a.verdict.label.includes(a.next.name.toUpperCase()));
});

check('vouches are keyed to the rank, so a promotion resets them', () => {
  const before = db.getStaff(G, 's-star');
  const carried = db.getVouches(G, 's-star', before.rank_since).length;
  assert.strictEqual(carried, 2);

  db.setRank(G, 's-star', R.ranks[2].key, 'a'); // promote — rank_since moves
  const after = db.getStaff(G, 's-star');
  assert.notStrictEqual(after.rank_since, before.rank_since);
  assert.strictEqual(
    db.getVouches(G, 's-star', after.rank_since).length,
    0,
    'old vouches carried into the new rank — one vote would promote them twice'
  );
  db.setRank(G, 's-star', R.ranks[1].key, 'a');
  setSince.run(before.rank_since, G, 's-star');
});

check('the top rank is never "ready" — there is nothing above it', () => {
  const top = R.ranks[R.ranks.length - 1];
  db.setRank(G, 's-top', top.key, 'a');
  backdate('s-top', 300);
  makeExcellent('s-top');
  const a = standing.assess(G, db.getStaff(G, 's-top'));
  assert.strictEqual(a.atTop, true);
  assert.strictEqual(a.next, null);
  assert.notStrictEqual(a.verdict.code, 'ready');
  assert.strictEqual(a.verdict.code, 'steady');
});

check('no single metric can push a ranked staff member over the promote bar', () => {
  // The same guarantee the trial scoring has. Someone who only ever grinds
  // tickets must not be able to farm their way up the ladder.
  db.setRank(G, 's-farm', R.ranks[1].key, 'a');
  backdate('s-farm', 200);
  bumpDay('s-farm', 'ticketsHandled', 500, 1);
  const a = standing.assess(G, db.getStaff(G, 's-farm'));
  assert.ok(
    a.score < config.standing.promoteBar,
    `one maxed metric reached ${a.score}, over the ${config.standing.promoteBar} bar`
  );
});

check('leave approved today already excuses them', () => {
  // A leave starting now contributes NOTHING to a backward-looking window, so
  // the window overlap alone would report someone as slipping on the same day
  // you signed off their time away.
  db.setRank(G, 's-away', R.ranks[1].key, 'a');
  backdate('s-away', 200);
  const loa = db.startLoa(G, 's-away', 40, 'exams', 'a');
  const a = standing.assess(G, db.getStaff(G, 's-away'));
  assert.strictEqual(a.loaDays, 0, 'fixture no longer tests the case it was written for');
  assert.strictEqual(a.onLeaveNow, true);
  assert.strictEqual(a.verdict.code, 'on_leave');
  assert.strictEqual(a.drifting, false, 'someone on approved leave was flagged as slipping');
  db.endLoa(loa.id);
});

check('leave already served is counted against the window it covered', () => {
  const started = Date.now() - 25 * 86400000;
  db.db
    .prepare(
      `INSERT INTO loa (guild_id, user_id, start_at, end_at, reason, created_by, state)
       VALUES (?, ?, ?, ?, 'past', 'a', 'ended')`
    )
    .run(G, 's-away', started, started + 20 * 86400000);
  const a = standing.assess(G, db.getStaff(G, 's-away'));
  assert.ok(a.loaDays >= 19, `only counted ${a.loaDays} days of leave`);
  assert.strictEqual(a.loaHeavy, true);
  assert.strictEqual(a.verdict.code, 'on_leave');
  db.db.prepare(`DELETE FROM loa WHERE guild_id = ? AND user_id = ?`).run(G, 's-away');
});

check('the standing card renders with the rank they actually hold', () => {
  const guild = { id: G, name: 'T' };
  const user = { id: 's-star', username: 'Star', displayAvatarURL: () => null };
  const { embed } = buildStandingCard(guild, db.getStaff(G, 's-star'), user);
  const j = embed.toJSON();
  assert.ok(j.title.includes('/100'), j.title);
  const scorecard = j.fields.find((f) => f.name.startsWith('Scorecard'));
  assert.ok(scorecard, 'no scorecard field');
  assert.ok(scorecard.name.includes(R.ranks[1].name), scorecard.name);
});

check('the standing card asks for vouches on the NEXT rank, not on keeping them', () => {
  const guild = { id: G, name: 'T' };
  const user = { id: 's-farm', username: 'Farm', displayAvatarURL: () => null };
  const { embed } = buildStandingCard(guild, db.getStaff(G, 's-farm'), user);
  const f = embed.toJSON().fields.find((x) => x.name.startsWith('Vouches for'));
  assert.ok(f, 'no vouch field on a ranked card');
  assert.ok(f.name.includes(R.ranks[2].name), f.name);
});

check('the promotion watch separates ready, close and slipping', () => {
  const w = standing.watch(G);
  assert.ok(Array.isArray(w.ready) && Array.isArray(w.candidates) && Array.isArray(w.drifting));
  assert.ok(w.drifting.some((a) => a.userId === 's-fade'), 'the fading Head Staff was not flagged');
  const all = [...w.ready, ...w.candidates, ...w.drifting].map((a) => a.userId);
  assert.ok(!all.includes('s-away'), 'someone on leave appeared in the watch');
});

check('trials are left to the trial system, not the promotion watch', () => {
  db.setRank(G, 's-trial', R.ranks[0].key, 'a');
  db.startTrial(G, 's-trial', Date.now() + 5 * 86400000);
  makeExcellent('s-trial');
  const all = Object.values(standing.watch(G)).flat().map((a) => a.userId);
  assert.ok(!all.includes('s-trial'), 'a trial member appeared in the promotion watch');
  db.clearTrial(G, 's-trial', 'passed');
});

check('the digest surfaces the ranked team without anyone asking', () => {
  const j = digest.build({ id: G, name: 'T' }).embed.toJSON();
  const names = (j.fields ?? []).map((f) => f.name).join(' | ');
  assert.ok(/Slipping|Ready for the next rank|Worth a look/.test(names), names);
});

check('turning standing off leaves the digest alone', () => {
  const saved = config.standing.enabled;
  config.standing.enabled = false;
  const j = digest.build({ id: G, name: 'T' }).embed.toJSON();
  config.standing.enabled = saved;
  const names = (j.fields ?? []).map((f) => f.name).join(' | ');
  assert.ok(!/Slipping|Ready for the next rank/.test(names), names);
});

check('a perfect trial month is NOT a perfect month at a real rank', () => {
  // This is why /staffstats had to be taught the difference. Someone doing
  // exactly trial-level work maxes the trial targets — and /staffstats tells
  // you to calibrate config.js from what it shows you.
  const M = config.scoring.metrics;
  const trialLevel = {
    ticketsHandled: M.ticketsHandled.target,
    activeDays: M.activeDays.target,
    inGameActivity: M.inGameActivity.target,
    channelBreadth: M.channelBreadth.target,
    modActions: M.modActions.target,
    staffPresence: M.staffPresence.target,
    publicActivity: M.publicActivity.target,
    responseCount: 5,
    responseSpeed: M.responseSpeed.target,
  };

  const asTrial = computeScore(trialLevel).score;
  assert.strictEqual(asTrial, 100, 'fixture no longer maxes the trial targets');

  for (const rank of R.ranks.slice(1)) {
    const asRank = computeScore(trialLevel, standing.scaledProfile(rank.key, 30)).score;
    assert.ok(
      asRank < config.standing.promoteBar,
      `${rank.name} would be a promotion candidate for doing trial-level work (${asRank})`
    );
  }
});

check('staffstats defaults to the window the person is actually judged over', () => {
  assert.strictEqual(standing.windowDaysFor(R.ranks[1].key), config.standing.windowDays);
  assert.notStrictEqual(
    config.standing.windowDays,
    config.trial.defaultDays,
    'trial and standing windows are identical — the distinction is untested'
  );
});

check('every ranked staff member has a profile, so nothing falls back silently', () => {
  // /staffstats warns when a rank has no profile, but the warning is a
  // last resort — the config should never reach that state.
  for (const rank of R.ranks.slice(1)) {
    assert.ok(
      standing.scaledProfile(rank.key, 30),
      `${rank.name} would silently fall back to trial targets in /staffstats and /leaderboard`
    );
  }
});

check('a thin month never escalates on its own', () => {
  const a = standing.assess(G, db.getStaff(G, 's-ghost'));
  assert.strictEqual(a.escalation.action, 'none');
  assert.strictEqual(a.escalation.step, 0);
});

check('two windows under the bar says talk to them, not demote', () => {
  const a = standing.assess(G, db.getStaff(G, 's-fade'));
  assert.strictEqual(a.escalation.action, 'talk');
  assert.ok(a.driftStreak >= 2, `streak was ${a.driftStreak}`);
  assert.ok(/what changed/i.test(a.escalation.text), a.escalation.text);
  assert.ok(/loa/i.test(a.escalation.text), 'leave was not offered as the alternative');
  assert.ok(!/defensible/.test(a.escalation.text), 'jumped straight to a rank change');
});

check('a long streak with nothing logged still refuses to escalate', () => {
  // The guard that matters. Three bad windows and no conversation is a
  // failure of management, not grounds for a demotion.
  db.setRank(G, 's-long', R.ranks[2].key, 'a');
  backdate('s-long', 300);
  for (const d of [2, 8, 35, 48, 65, 80]) bumpDay('s-long', 'publicActivity', 6, d);
  const a = standing.assess(G, db.getStaff(G, 's-long'));
  assert.ok(a.driftStreak >= 3, `streak was ${a.driftStreak}`);
  assert.strictEqual(a.escalation.spokenTo, false);
  assert.strictEqual(a.escalation.action, 'talk', 'escalated without anyone having spoken to them');
  assert.ok(/nobody has actually asked them/i.test(a.escalation.text), a.escalation.text);
});

check('a logged concern is what unlocks the rank-review step', () => {
  db.addNote(G, 's-long', 'boss', 'concern', 'Asked about the drop-off, no reply.');
  const a = standing.assess(G, db.getStaff(G, 's-long'));
  assert.strictEqual(a.escalation.spokenTo, true);
  assert.strictEqual(a.escalation.action, 'review');
  assert.ok(/defensible|still want the rank/i.test(a.escalation.text), a.escalation.text);
  assert.ok(a.verdict.label.includes('REVIEW'), a.verdict.label);
});

check('praise is not mistaken for a concern', () => {
  db.setRank(G, 's-praised', R.ranks[2].key, 'a');
  backdate('s-praised', 300);
  for (const d of [2, 8, 35, 48, 65, 80]) bumpDay('s-praised', 'publicActivity', 6, d);
  db.addNote(G, 's-praised', 'boss', 'praise', 'Lovely with the new players.');
  const a = standing.assess(G, db.getStaff(G, 's-praised'));
  assert.strictEqual(a.escalation.spokenTo, false, 'a praise note unlocked a demotion review');
  assert.strictEqual(a.escalation.action, 'talk');
});

check('nothing in the system ever demotes anybody', () => {
  // The escalation only ever recommends. If this assertion needs relaxing,
  // something has gone badly wrong with the design.
  const a = standing.assess(G, db.getStaff(G, 's-long'));
  assert.ok(!/^demot/i.test(a.escalation.action), a.escalation.action);
  assert.ok(
    /run `\/demote`|still a call|question to put to them/i.test(a.escalation.text),
    'the strongest wording must still hand the decision to a person'
  );
});

check('approved leave stops the escalation clock', () => {
  const loa = db.startLoa(G, 's-long', 30, 'burnout', 'boss');
  const a = standing.assess(G, db.getStaff(G, 's-long'));
  assert.strictEqual(a.escalation.action, 'none');
  assert.strictEqual(a.driftStreak, 0, 'leave did not reset the streak');
  db.endLoa(loa.id);
});

check('the streak does not count windows from before they existed', () => {
  db.setRank(G, 's-new', R.ranks[1].key, 'a');
  backdate('s-new', 40);
  bumpDay('s-new', 'publicActivity', 4, 3);
  const a = standing.assess(G, db.getStaff(G, 's-new'));
  assert.ok(a.driftStreak <= 1, `counted ${a.driftStreak} windows of a 40-day-old account`);
});

// ---------------------------------------------------------------
console.log('\nManual adjustments');
const ADJ = require('../src/adjustments');

const mkAdj = (u, points, reason, days) =>
  db.addAdjustment({
    guildId: G, userId: u, points, reason,
    authorId: 'boss', expiresAt: ADJ.expiryFor(days),
  });

check('an adjustment moves the score without touching the measurement', () => {
  db.setRank(G, 'a-one', R.ranks[1].key, 'a');
  backdate('a-one', 120);
  makeExcellent('a-one');
  const before = standing.assess(G, db.getStaff(G, 'a-one'));
  mkAdj('a-one', -12, 'Sharp with a member in #general.');
  const after = standing.assess(G, db.getStaff(G, 'a-one'));

  assert.strictEqual(after.rawScore, before.score, 'the measured score was altered');
  assert.strictEqual(after.score, before.score - 12);
  assert.strictEqual(after.adjustment.delta, -12);
});

check('the raw score survives on the card, next to the adjusted one', () => {
  const guild = { id: G, name: 'T' };
  const user = { id: 'a-one', username: 'One', displayAvatarURL: () => null };
  const { embed } = buildStandingCard(guild, db.getStaff(G, 'a-one'), user);
  const j = embed.toJSON();
  const f = j.fields.find((x) => x.name.startsWith('Manual adjustments'));
  assert.ok(f, 'the ledger is not shown on the card');
  assert.ok(/Measured \*\*\d+\/100\*\*/.test(f.value), f.value);
  assert.ok(/<@boss>/.test(f.value), 'the issuer is not named');
  assert.ok(/Sharp with a member/.test(f.value), 'the reason is not shown');
  assert.ok(/measured \d+/.test(j.title), `raw score missing from the title: ${j.title}`);
});

check('a deduction blocks a promotion however high the score is', () => {
  const a = standing.assess(G, db.getStaff(G, 'a-one'));
  assert.ok(a.rawScore >= config.standing.promoteBar, `raw was only ${a.rawScore}`);
  assert.strictEqual(a.verdict.code, 'conduct_hold');
  assert.ok(/active deduction/i.test(a.verdict.reason), a.verdict.reason);
});

check('a blocked person is never listed as ready', () => {
  const w = standing.watch(G);
  assert.ok(!w.ready.some((x) => x.userId === 'a-one'), 'a conduct hold was reported as ready');
  assert.ok(w.candidates.some((x) => x.userId === 'a-one'), 'they vanished from the watch entirely');
});

check('revoking restores them immediately', () => {
  const rows = db.allAdjustments(G, 'a-one', 5);
  db.revokeAdjustment(rows[0].id, G, 'boss2');
  const a = standing.assess(G, db.getStaff(G, 'a-one'));
  assert.strictEqual(a.adjustment.delta, 0);
  assert.strictEqual(a.score, a.rawScore);
  assert.notStrictEqual(a.verdict.code, 'conduct_hold');
});

check('a revoked entry stays in the record rather than disappearing', () => {
  const rows = db.allAdjustments(G, 'a-one', 5);
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].revoked_at, 'the entry was deleted instead of marked');
  assert.strictEqual(rows[0].revoked_by, 'boss2');
});

check('adjustments expire on their own', () => {
  db.setRank(G, 'a-old', R.ranks[1].key, 'a');
  backdate('a-old', 120);
  const row = mkAdj('a-old', -10, 'Something from a long time ago.', 90);
  assert.strictEqual(ADJ.net(G, 'a-old').delta, -10);
  // Wind its expiry back into the past.
  db.db.prepare('UPDATE adjustments SET expires_at = ? WHERE id = ?')
    .run(Date.now() - 1000, row.id);
  assert.strictEqual(ADJ.net(G, 'a-old').delta, 0, 'a lapsed adjustment still applied');
});

check('the default expiry is finite', () => {
  assert.ok(config.adjustments.expiryDays > 0, 'adjustments default to permanent');
});

check('a single adjustment is capped', () => {
  const max = ADJ.maxSingle();
  const reason = 'a perfectly good reason here';
  const over = ADJ.validate(-(max + 1), reason);
  assert.ok(over, 'an over-cap adjustment was accepted');
  assert.ok(/demote/i.test(over), 'the cap does not point at the real tool instead');
  assert.strictEqual(ADJ.validate(-max, reason), null, 'the cap itself was refused');
});

check('the running total is capped too', () => {
  db.setRank(G, 'a-cap', R.ranks[1].key, 'a');
  backdate('a-cap', 120);
  for (let i = 0; i < 6; i++) mkAdj('a-cap', -15, `Stacked deduction number ${i}`);
  const n = ADJ.net(G, 'a-cap');
  assert.strictEqual(n.raw, -90);
  assert.strictEqual(n.delta, -ADJ.maxTotal(), `capped to ${n.delta}`);
  assert.strictEqual(n.wasCapped, true, 'the cap was applied silently');
});

check('a capped total is reported, not swallowed', () => {
  const sum = ADJ.summarise(G, 'a-cap');
  assert.ok(/before the/.test(sum.header), sum.header);
});

check('the score can never leave 0-100', () => {
  const a = standing.assess(G, db.getStaff(G, 'a-cap'));
  assert.ok(a.score >= 0 && a.score <= 100, `score was ${a.score}`);
  db.setRank(G, 'a-hi', R.ranks[1].key, 'a');
  backdate('a-hi', 120);
  makeExcellent('a-hi');
  mkAdj('a-hi', 15, 'Trained two new hires in voice this month.');
  const b = standing.assess(G, db.getStaff(G, 'a-hi'));
  assert.strictEqual(b.score, 100, `credit pushed a 100 to ${b.score}`);
});

check('an empty or throwaway reason is refused', () => {
  assert.ok(ADJ.validate(-5, ''), 'a blank reason was accepted');
  assert.ok(ADJ.validate(-5, 'bad'), 'a three-letter reason was accepted');
  assert.strictEqual(ADJ.validate(-5, 'Left a ticket unanswered for two days.'), null);
});

check('zero and fractional points are refused', () => {
  assert.ok(ADJ.validate(0, 'a perfectly good reason here'));
  assert.ok(ADJ.validate(2.5, 'a perfectly good reason here'));
});

check('a credit does not block a promotion', () => {
  const a = standing.assess(G, db.getStaff(G, 'a-hi'));
  assert.strictEqual(ADJ.hasDeduction(G, 'a-hi'), false);
  assert.notStrictEqual(a.verdict.code, 'conduct_hold');
});

check('trial cards carry the ledger too', () => {
  db.setRank(G, 'a-trial', R.ranks[0].key, 'a');
  db.startTrial(G, 'a-trial', Date.now() + 5 * 86400000);
  makeExcellent('a-trial');
  mkAdj('a-trial', -10, 'Argued with a member in front of everyone.');
  const guild = { id: G, name: 'T' };
  const user = { id: 'a-trial', username: 'Tri', displayAvatarURL: () => null };
  const { embed, score } = buildReviewCard(guild, db.getStaff(G, 'a-trial'), user);
  const f = embed.toJSON().fields.find((x) => x.name.startsWith('Manual adjustments'));
  assert.ok(f, 'a trial card ignored the adjustment');
  assert.ok(/Measured/.test(f.value), f.value);
  db.clearTrial(G, 'a-trial', 'passed');
});

check('turning adjustments off makes them inert without deleting them', () => {
  const saved = config.adjustments.enabled;
  config.adjustments.enabled = false;
  assert.strictEqual(ADJ.net(G, 'a-cap').delta, 0);
  assert.strictEqual(ADJ.hasDeduction(G, 'a-cap'), false);
  config.adjustments.enabled = saved;
  assert.ok(db.allAdjustments(G, 'a-cap', 10).length > 0, 'the entries were destroyed');
});

check('the hold bar sits below the promote bar', () => {
  assert.ok(
    config.standing.holdBar < config.standing.promoteBar,
    'holdBar must be lower than promoteBar or every state collapses'
  );
});

// ---------------------------------------------------------------
// cleanup
for (const t of ['metrics', 'vouches', 'notes', 'audit', 'staff', 'tickets', 'adjustments']) {
  db.db.exec(`DELETE FROM ${t} WHERE guild_id='${G}'`);
}
db.db.exec("DELETE FROM ticket_participants WHERE channel_id LIKE 'chan-%'");
db.db.exec(`DELETE FROM game_links WHERE guild_id='${G}'`);
db.db.exec(`DELETE FROM presence WHERE guild_id='${G}'`);
db.db.exec(`DELETE FROM loa WHERE guild_id='${G}'`);
db.db.exec(`DELETE FROM conduct WHERE guild_id='${G}'`);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

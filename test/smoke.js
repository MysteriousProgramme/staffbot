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

check('every permission key names a real rank', () => {
  const keys = R.ranks.map((r) => r.key);
  for (const [name, val] of Object.entries(config.permissions)) {
    if (name === 'overrideRoleIds') continue;
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
// cleanup
for (const t of ['metrics', 'vouches', 'notes', 'audit', 'staff', 'tickets']) {
  db.db.exec(`DELETE FROM ${t} WHERE guild_id='${G}'`);
}
db.db.exec("DELETE FROM ticket_participants WHERE channel_id LIKE 'chan-%'");
db.db.exec(`DELETE FROM game_links WHERE guild_id='${G}'`);
db.db.exec(`DELETE FROM presence WHERE guild_id='${G}'`);
db.db.exec(`DELETE FROM conduct WHERE guild_id='${G}'`);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

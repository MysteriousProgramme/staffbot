/**
 * /trial pass and /trial fail, driven against a fake Discord.
 *
 * These two move people up the ladder and off the team, so they get executed
 * here rather than only checked for existence like the other commands.
 *
 * Run with: npm test
 */
const config = require('../config');
const db = require('../src/db');
const R = require('../src/ranks');
const trial = require('../src/commands/trial');

const G = 'trial-guild';
const DAY = 86400000;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '\n      ' + extra : '')); }
};

const posted = { reviews: [], log: [], announce: [], dm: [] };

const member = (id, name, roleIds = []) => {
  const m = {
    id,
    displayName: name,
    user: {
      id, username: name, tag: name + '#0001', bot: false,
      displayAvatarURL: () => null,
      send: async (p) => posted.dm.push({ id, p }),
    },
    roles: {
      cache: new Map(roleIds.map((r) => [r, true])),
      add: async (ids) => [].concat(ids).forEach((r) => m.roles.cache.set(r, true)),
      remove: async (ids) => [].concat(ids).forEach((r) => m.roles.cache.delete(r)),
    },
  };
  return m;
};

const members = new Map();
const guild = {
  id: G, name: 'Tempest SMP', ownerId: 'owner-1',
  channels: {
    fetch: async (id) => ({
      id, isTextBased: () => true,
      send: async (p) => {
        (id === config.channels.reviews ? posted.reviews : posted.log).push(p);
      },
    }),
  },
  members: { fetch: async (id) => members.get(id) ?? null },
  roles: { cache: new Map() },
};
for (const m of Object.values({})) void m;

function interaction(sub, opts, actorId) {
  const actor = members.get(actorId);
  actor.guild = guild;
  const replies = [];
  return {
    guildId: G,
    guild,
    member: actor,
    user: actor.user,
    options: {
      getSubcommand: () => sub,
      getUser: (n) => members.get(opts[n])?.user ?? null,
      getString: (n) => opts[n] ?? null,
      getInteger: (n) => opts[n] ?? null,
    },
    replied: false,
    deferred: false,
    reply: async (p) => { replies.push(p); return p; },
    editReply: async (p) => { replies.push(p); return p; },
    followUp: async (p) => { replies.push(p); return p; },
    _replies: replies,
  };
}

const text = (i) =>
  i._replies
    .flatMap((r) => (r.embeds ?? []).map((e) => (e.toJSON ? e.toJSON() : e).description ?? ''))
    .join(' ') + ' ' + i._replies.map((r) => r.content ?? '').join(' ');

(async () => {
  for (const t of ['staff', 'metrics', 'audit', 'vouches', 'notes']) {
    db.db.exec(`DELETE FROM ${t} WHERE guild_id='${G}'`);
  }

  const TRIAL = R.ranks[0];
  const NEXT = R.ranks[1];
  const TOP = R.ranks[R.ranks.length - 1];

  members.set('boss', member('boss', 'Owner', [TOP.roleId]));
  members.set('rookie', member('rookie', 'Rookie', [TRIAL.roleId]));
  members.set('dud', member('dud', 'Dud', [TRIAL.roleId]));
  members.set('peer', member('peer', 'Peer', [TRIAL.roleId]));
  for (const m of members.values()) m.guild = guild;

  // ---- refuses somebody who is not on a trial ----
  db.setRank(G, 'rookie', TRIAL.key, 'boss');
  let i = interaction('pass', { user: 'rookie', reason: 'good work all round' }, 'boss');
  await trial.execute(i);
  check('refuses to pass someone who is not on a trial', /not on a trial/i.test(text(i)), text(i));

  // ---- pass ----
  db.startTrial(G, 'rookie', Date.now() + 3 * DAY);
  db.bumpMetric(G, 'rookie', 'ticketsHandled', 9);
  i = interaction('pass', { user: 'rookie', reason: 'handled tickets well and stayed visible' }, 'boss');
  await trial.execute(i);

  const rookie = db.getStaff(G, 'rookie');
  check('pass moves them up the ladder', rookie?.rank_key === NEXT.key, JSON.stringify(rookie));
  check('pass resolves the trial', rookie?.trial_state === 'passed', rookie?.trial_state);
  check('pass swaps the Discord roles', members.get('rookie').roles.cache.has(NEXT.roleId) && !members.get('rookie').roles.cache.has(TRIAL.roleId));
  check('pass posts the final scorecard to reviews', posted.reviews.length === 1, posted.reviews.length + ' posted');
  check('pass DMs the person', posted.dm.some((d) => d.id === 'rookie'));
  check('the receipt carries the score and the verdict', /\/100/.test(text(i)) && /READY|BORDERLINE|BELOW BAR/.test(text(i)), text(i));

  const auditPass = db.getAudit(G, 'rookie', 5)[0];
  check('the audit row records the score alongside the decision',
    auditPass?.action === 'trial_pass' && /scored \d+\/100/.test(auditPass.detail), JSON.stringify(auditPass));

  // ---- already resolved ----
  i = interaction('pass', { user: 'rookie', reason: 'again' }, 'boss');
  await trial.execute(i);
  check('will not re-resolve a finished trial', /already resolved/i.test(text(i)), text(i));

  // ---- fail ----
  db.setRank(G, 'dud', TRIAL.key, 'boss');
  db.startTrial(G, 'dud', Date.now() + 3 * DAY);
  i = interaction('fail', { user: 'dud', reason: 'went quiet for the whole window' }, 'boss');
  await trial.execute(i);

  check('fail removes them from the staff table', !db.getStaff(G, 'dud'));
  check('fail strips the rank role', !members.get('dud').roles.cache.has(TRIAL.roleId));
  check('fail still posts the scorecard', posted.reviews.length === 2, posted.reviews.length + ' posted');
  check('fail DMs the person', posted.dm.some((d) => d.id === 'dud'));
  const auditFail = db.getAudit(G, 'dud', 5)[0];
  check('the audit row survives the staff row being deleted',
    auditFail?.action === 'trial_fail' && /removed/.test(auditFail.detail), JSON.stringify(auditFail));

  // ---- rank guardrail ----
  db.setRank(G, 'peer', TRIAL.key, 'boss');
  db.startTrial(G, 'peer', Date.now() + 3 * DAY);
  i = interaction('pass', { user: 'peer', reason: 'x', rank: TOP.key }, 'boss');
  await trial.execute(i);
  check('cannot pass someone up to the actor\u2019s own rank',
    /at or above your own rank/i.test(text(i)), text(i));
  check('a refused pass leaves the trial untouched',
    db.getStaff(G, 'peer')?.trial_state === 'active', db.getStaff(G, 'peer')?.trial_state);

  for (const t of ['staff', 'metrics', 'audit', 'vouches', 'notes']) {
    db.db.exec(`DELETE FROM ${t} WHERE guild_id='${G}'`);
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAILED:', e); process.exit(1); });

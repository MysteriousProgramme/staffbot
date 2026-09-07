/**
 * Dashboard tests. Run with: npm test
 *
 * Starts the real HTTP server against a fake Discord client and drives it over
 * the network, so auth, the CSP, the write guards and the config allowlist are
 * exercised the way a browser would exercise them.
 */
process.env.WEB_TOKEN = 'test-token-that-is-long-enough';
process.env.GUILD_ID = 'webguild';
process.env.USER_ID = 'owner-1';

const config = require('../config');
config.web.port = 8791;
config.web.enabled = true;
config.tickets.staffRoleIds = ['role-staff'];

const db = require('../src/db');
const R = require('../src/ranks');
const web = require('../src/web/server');

const G = 'webguild';
const BASE = 'http://127.0.0.1:8791';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '\n      ' + extra : '')); }
};

const member = (id, name, roleIds = []) => ({
  id,
  displayName: name,
  user: { id, username: name, tag: name + '#0001', bot: false, displayAvatarURL: () => null },
  displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/x.png`,
  roles: { cache: new Map(roleIds.map((r) => [r, true])), add: async () => {}, remove: async () => {} },
  guild: null,
});

const members = new Map();
const guild = {
  id: G,
  name: 'Tempest SMP',
  memberCount: 812,
  ownerId: 'owner-1',
  roles: {
    everyone: { id: G },
    cache: new Map([
      ['role-staff', { id: 'role-staff', name: 'Staff Team', position: 5, hexColor: '#fff' }],
      [R.ranks[0].roleId, { id: R.ranks[0].roleId, name: R.ranks[0].name, position: 4, hexColor: '#aaa' }],
    ]),
  },
  channels: {
    cache: new Map([['chan-1', { id: 'chan-1', name: 'general', type: 0, parentId: null }]]),
    fetch: async (id) => (id === 'chan-1' ? { id, name: 'general', isTextBased: () => true, send: async () => {} } : null),
  },
  members: { fetch: async (id) => members.get(id) ?? null },
};
for (const m of [member('owner-1', 'Owner'), member('staff-1', 'Handler', [R.ranks[0].roleId])]) {
  m.guild = guild;
  members.set(m.id, m);
}

const client = {
  user: { tag: 'Imperial#1234' },
  isReady: () => true,
  guilds: { cache: new Map([[G, guild]]) },
};

// Clear this guild's rows FIRST. A run that dies partway through would
// otherwise poison every run after it with a UNIQUE constraint on the seed.
function wipe() {
  for (const t of ['tickets', 'staff', 'metrics', 'audit', 'notes', 'vouches', 'ticket_blacklist']) {
    db.db.exec(`DELETE FROM ${t} WHERE guild_id='${G}'`);
  }
  db.db.exec("DELETE FROM ticket_participants WHERE channel_id LIKE 'chan-t%'");
  try {
    require('fs').unlinkSync(config.overridesPath);
  } catch {
    /* nothing to clear */
  }
}
wipe();

// seed
db.setRank(G, 'staff-1', R.ranks[0].key, 'owner-1');
db.bumpMetric(G, 'staff-1', 'ticketsHandled', 4);
db.createTicket({
  guildId: G, channelId: 'chan-t1', channelName: 'ticket-0001',
  openerId: 'owner-1', number: 1, typeKey: 'support', subject: 'griefed at spawn',
});
db.addTicketBlacklist(G, '111222333444555666', 'spam', 'owner-1');

let cookie = '';
async function req(path, { method = 'GET', body, headers = {}, useCookie = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(useCookie && cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await res.json(); } catch { /* html */ }
  return { status: res.status, json, res };
}

(async () => {
  web.start(client);
  await new Promise((r) => setTimeout(r, 400));

  console.log('\nAuth');
  check('an unauthenticated API call is refused', (await req('/api/overview')).status === 401);
  check('a wrong token is refused', (await req('/api/login', { method: 'POST', body: { token: 'nope' } })).status === 401);

  const login = await req('/api/login', { method: 'POST', body: { token: process.env.WEB_TOKEN } });
  const setCookie = login.res.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0];
  check('the right token signs in', login.status === 200 && cookie.startsWith('sb_session='));
  check('the session cookie is HttpOnly and SameSite=Strict',
    /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie);

  console.log('\nSecurity');
  const noHeader = await req('/api/config', { method: 'POST', body: { changes: {} }, headers: {} });
  check('a write without the dashboard header is refused', noHeader.status === 403, JSON.stringify(noHeader.json));

  const traversal = await req('/../../config.js');
  check('path traversal cannot escape the public directory', traversal.status === 404 || traversal.status === 403,
    'got ' + traversal.status);

  const csp = (await req('/api/overview')).res.headers.get('content-security-policy') ?? '';
  check('a CSP is sent and allows Discord avatars',
    csp.includes("script-src 'self'") && csp.includes('cdn.discordapp.com'), csp);

  const H = { 'X-Staffbot': 'dashboard' };

  console.log('\nReading');
  const ov = await req('/api/overview');
  check('overview reports the bot and the counts',
    ov.status === 200 && ov.json.bot.tag === 'Imperial#1234' && ov.json.counts.openTickets === 1,
    JSON.stringify(ov.json?.counts));

  const staff = await req('/api/staff');
  check('the roster lists staff with a score',
    staff.status === 200 && staff.json.staff.length === 1 && typeof staff.json.staff[0].score === 'number',
    JSON.stringify(staff.json?.staff));

  const detail = await req('/api/staff/staff-1');
  check('staff detail carries the metric breakdown',
    detail.status === 200 && Array.isArray(detail.json.breakdown) && detail.json.breakdown.length > 0);
  check('detail includes notes, audit and ticket stats',
    detail.json.notes && detail.json.audit && detail.json.ticketStats);

  const tix = await req('/api/tickets');
  check('open tickets come back with the subject',
    tix.status === 200 && tix.json.tickets[0].subject === 'griefed at spawn');

  const bl = await req('/api/blacklist');
  check('the blacklist resolves who blocked whom',
    bl.status === 200 && bl.json.blacklist[0].reason === 'spam' && bl.json.blacklist[0].by.name === 'Owner');

  const roles = await req('/api/roles');
  check('roles are listed for the pickers', roles.json.roles.length === 2);

  const cfg = await req('/api/config');
  check('config exposes only the allowlisted keys',
    cfg.json.editable.includes('tickets.maxOpenPerUser') && !cfg.json.editable.includes('permissions.manageStaff'));

  console.log('\nWriting');
  const save = await req('/api/config', {
    method: 'POST', headers: H, body: { changes: { 'tickets.maxOpenPerUser': 4 } },
  });
  check('a config change is saved', save.status === 200 && save.json.saved.includes('tickets.maxOpenPerUser'));
  check('the change is live in the running process', config.tickets.maxOpenPerUser === 4);

  const fsx = require('fs');
  const written = JSON.parse(fsx.readFileSync(config.overridesPath, 'utf8'));
  check('it went to config.local.json, not config.js', written.tickets.maxOpenPerUser === 4);
  check('config.js on disk is untouched',
    fsx.readFileSync(require('path').join(__dirname, '..', 'config.js'), 'utf8')
      .includes('maxOpenPerUser: 1'));

  const denied = await req('/api/config', {
    method: 'POST', headers: H, body: { changes: { 'permissions.manageStaff': 'trial' } },
  });
  check('a non-allowlisted key is refused', denied.status === 403, JSON.stringify(denied.json));

  const reset = await req('/api/config/reset', { method: 'POST', headers: H, body: { key: 'tickets.maxOpenPerUser' } });
  check('an override can be removed', reset.status === 200);
  check('removing it empties the overrides file',
    JSON.parse(fsx.readFileSync(config.overridesPath, 'utf8')).tickets?.maxOpenPerUser === undefined);

  const note = await req('/api/staff/staff-1/note', {
    method: 'POST', headers: H, body: { kind: 'praise', body: 'Handled a nasty ticket well.' },
  });
  check('a note can be added', note.status === 200 && db.getNotes(G, 'staff-1', 5)[0].kind === 'praise');

  const vouch = await req('/api/staff/staff-1/vouch', { method: 'POST', headers: H, body: { verdict: 'yes' } });
  check('a vouch is recorded', vouch.status === 200);

  const badVouch = await req('/api/staff/staff-1/vouch', { method: 'POST', headers: H, body: { verdict: 'maybe' } });
  check('a nonsense verdict is refused', badVouch.status === 400);

  const noReason = await req('/api/staff/staff-1/promote', { method: 'POST', headers: H, body: { rank: 'staff' } });
  check('a promotion without a reason is refused', noReason.status === 400, JSON.stringify(noReason.json));

  const blAdd = await req('/api/blacklist', {
    method: 'POST', headers: H, body: { userId: '999888777666555444', reason: 'testing' },
  });
  check('someone can be blocked', blAdd.status === 200 && db.isTicketBlacklisted(G, '999888777666555444'));

  const blBad = await req('/api/blacklist', { method: 'POST', headers: H, body: { userId: 'not-an-id' } });
  check('a bad user id is refused', blBad.status === 400);

  const blDel = await req('/api/blacklist/999888777666555444', { method: 'DELETE', headers: H });
  check('and unblocked', blDel.status === 200 && !db.isTicketBlacklisted(G, '999888777666555444'));

  console.log('\nStatic');
  const page = await req('/');
  check('the page is served', page.status === 200);
  const js = await req('/app.js');
  check('app.js is served as javascript',
    js.res.headers.get('content-type')?.includes('javascript'));

  wipe();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAILED:', e); process.exit(1); });

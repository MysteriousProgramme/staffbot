/**
 * Config checklist. Run with: npm run check   (or double-click check.bat)
 *
 * Tells you exactly what's still a placeholder and what's optional,
 * without needing to connect to Discord.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const config = require('../config');

const G = '\x1b[32m';
const R_ = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[90m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const isId = (v) => /^\d{15,20}$/.test(String(v ?? ''));
// Real Discord snowflakes never start with 0, so a leading zero means it's
// still one of the placeholders shipped in config.js.
const placeholder = (v) => String(v ?? '').startsWith('0');

let required = 0;
let done = 0;
let optional = 0;
const problemsExtra = [];

function line(label, value, { req = true, hint = '' } = {}) {
  const ok = isId(value) && !placeholder(value);
  if (req) {
    required++;
    if (ok) done++;
  } else if (!ok) {
    optional++;
  }
  const mark = ok ? `${G}✓${X}` : req ? `${R_}✗${X}` : `${Y}–${X}`;
  const miss = req ? R_ : Y;
  const shown = ok ? `${D}${value}${X}` : `${miss}not set${X}`;
  console.log(`   ${mark} ${label.padEnd(34)} ${shown}${hint && !ok ? `\n       ${D}${hint}${X}` : ''}`);
}

function listLine(label, arr, { req = true, hint = '' } = {}) {
  const clean = (arr ?? []).filter((v) => isId(v) && !placeholder(v));
  const ok = clean.length > 0;
  if (req) {
    required++;
    if (ok) done++;
  } else if (!ok) {
    optional++;
  }
  const mark = ok ? `${G}✓${X}` : req ? `${R_}✗${X}` : `${Y}–${X}`;
  console.log(
    `   ${mark} ${label.padEnd(34)} ${ok ? `${D}${clean.length} set${X}` : req ? `${R_}none set${X}` : `${Y}none set${X}`}` +
      (!ok && hint ? `\n       ${D}${hint}${X}` : '')
  );
}

console.log(`\n${B}Staffbot config check${X}\n`);

// ---- .env ----
console.log(`${B}.env${X}`);
for (const [k, hint] of [
  ['DISCORD_TOKEN', 'Developer Portal > Bot > Reset Token'],
  ['CLIENT_ID', 'Developer Portal > General Information > Application ID'],
  ['GUILD_ID', 'Right-click your server > Copy Server ID'],
]) {
  const v = process.env[k];
  const ok = Boolean(v) && !v.startsWith('your_');
  required++;
  if (ok) done++;
  console.log(
    `   ${ok ? `${G}✓${X}` : `${R_}✗${X}`} ${k.padEnd(34)} ${ok ? `${D}set${X}` : `${R_}missing${X}\n       ${D}${hint}${X}`}`
  );
}

// ---- ranks ----
console.log(`\n${B}Rank roles${X} ${D}(config.ranks)${X}`);
config.ranks.forEach((r, i) => line(`${i}. ${r.name}`, r.roleId, { hint: 'Right-click the role > Copy Role ID' }));

console.log(`\n${B}Other roles${X}`);
line('Staff Team ping role', config.staffTeamRoleId, {
  hint: 'Your existing "Staff Team" role. Set to null in config.js if you do not want one.',
});
listLine('Owner / Founder bypass roles', config.permissions.overrideRoleIds, {
  req: false,
  hint: 'permissions.overrideRoleIds — add your Owner/Founder/Co-Owner role IDs so they bypass all rank checks. Server owner always bypasses anyway.',
});

// ---- channels ----
console.log(`\n${B}Channels${X}`);
if (config.channels.staffLog === null) {
  console.log(
    `   ${Y}–${X} ${'Private staff log'.padEnd(34)}${Y}turned off${X}\n` +
      `       ${D}reasons live in the database + DMs; read them with /staffstats${X}`
  );
} else {
  line('Private staff log', config.channels.staffLog, {
    req: false,
    hint: 'Optional in-channel audit trail. null = off.',
  });
}
line('Trial reviews', config.channels.reviews, { hint: 'Where scorecards get posted' });
listLine('Staff channels', config.channels.staffChannels, {
  hint: 'Messages here count as "staff presence" instead of public activity',
});
listLine('Ignored channels', config.channels.ignored, {
  req: false,
  hint: 'Optional. Bot-command spam, counting games — anywhere that should count toward nothing.',
});

const ann = config.announcements ?? {};
if (ann.channelId === null) {
  console.log(`   ${Y}–${X} ${'Staff movements (public)'.padEnd(34)}${Y}turned off${X}`);
} else {
  line('Staff movements (public)', ann.channelId, {
    req: false,
    hint: 'Optional. Member-facing promotions channel. Set to null in config.js to disable.',
  });
  if (isId(ann.channelId) && !placeholder(ann.channelId)) {
    const on = [
      ann.onHire && 'hires',
      ann.onPromote && 'promotions',
      ann.onDemote && 'demotions',
      ann.onRemove && 'removals',
    ].filter(Boolean);
    console.log(`   ${D}announcing: ${on.length ? on.join(', ') : 'nothing (all four switches are off)'}${X}`);
    if (String(ann.channelId) === String(config.channels.staffLog)) {
      problemsExtra.push(
        'announcements.channelId is the same channel as channels.staffLog — members would see the full internal log, reasons included'
      );
    }
  }
}

// ---- in-game chat ----
const gc = config.gameChat ?? {};
if (gc.enabled) {
  console.log(`\n${B}In-game chat bridge${X}`);
  line('Bridge channel', gc.channelId, {
    hint: 'The Discord channel that mirrors Minecraft chat. Without it, in-game presence (18% of the score) is skipped entirely.',
  });
  for (const [k, lbl] of [['namePattern', 'Name pattern'], ['ignorePattern', 'Noise filter']]) {
    let okRe = true;
    try {
      if (gc[k]) new RegExp(gc[k]);
    } catch (e) {
      okRe = false;
      problemsExtra.push(`gameChat.${k} is not a valid regex: ${e.message}`);
    }
    console.log(
      `   ${gc[k] ? (okRe ? `${G}✓${X}` : `${R_}✗${X}`) : `${Y}–${X}`} ${lbl.padEnd(34)}` +
        `${D}${gc[k] ? (okRe ? 'valid' : 'INVALID') : 'not set'}${X}`
    );
  }
  console.log(`   ${D}webhook bridges need no pattern — the webhook name is the IGN${X}`);
  console.log(`   ${D}link names in Discord with /link set${X}`);
} else {
  console.log(`\n${B}In-game chat bridge${X}\n   ${Y}–${X} disabled — in-game presence is skipped and the other metrics reweight`);
}

// ---- tickets ----
const tk = config.ticketKing ?? {};
if (tk.enabled) {
  console.log(`\n${B}Ticket King${X}`);
  const cats = (tk.categoryIds ?? []).filter((c) => isId(c) && !placeholder(c));
  const ok = cats.length > 0;
  required++;
  if (ok) done++;
  console.log(
    `   ${ok ? `${G}✓${X}` : `${R_}✗${X}`} ${'Ticket categories'.padEnd(34)} ` +
      (ok ? `${D}${cats.length} set${X}` : `${R_}none set${X}`)
  );
  if (!ok) {
    console.log(`       ${D}ticketKing.categoryIds — the CATEGORY Ticket King creates${X}`);
    console.log(`       ${D}ticket channels in. Right-click the category > Copy ID.${X}`);
    console.log(`       ${D}Without it, ticket work counts for nothing (30% of the score).${X}`);
  }
  line('Ticket King bot user ID', tk.botUserId, {
    req: false,
    hint: 'Only needed for claim detection. Default is Ticket King\'s public ID.',
  });
  let reOk = true;
  try {
    if (tk.claimPattern) new RegExp(tk.claimPattern);
  } catch (e) {
    reOk = false;
    problemsExtra.push(`ticketKing.claimPattern is not a valid regex: ${e.message}`);
  }
  console.log(
    `   ${tk.claimPattern ? (reOk ? `${G}✓${X}` : `${R_}✗${X}`) : `${Y}–${X}`} ` +
      `${'Claim detection'.padEnd(34)}${D}${tk.claimPattern ? (reOk ? 'pattern valid' : 'INVALID') : 'off'}${X}`
  );
  console.log(
    `   ${D}credit rule: claimer if detected, else top talker with ${tk.minMessagesToCredit ?? 3}+ messages${X}`
  );
} else {
  console.log(`\n${B}Ticket King${X}\n   ${Y}–${X} integration disabled — ticket metrics will always read 0`);
}

// ---- who can run what ----
{
  const R = require('./ranks');
  const nameOf = (k) => R.rankByKey(k)?.name ?? k;
  console.log(`\n${B}Who can run commands${X}`);
  for (const [label, key] of [
    ['/promote /demote /trial', config.permissions.manageStaff],
    ['/vouch', config.permissions.vouch],
    ['/review /note /staffstats /link', config.permissions.review],
  ]) {
    console.log(`   ${D}${label.padEnd(32)}${X}${nameOf(key)} and above`);
  }
  const ov = (config.permissions.overrideRoleIds ?? []).length;
  console.log(`   ${D}${'override roles (bypass all)'.padEnd(32)}${X}${ov} configured`);

  const vouchIdx = R.indexOfKey(config.permissions.vouch);
  const tiersAbove = R.ranks.length - vouchIdx;
  const min = config.scoring?.vouches?.minimum ?? 2;
  if (vouchIdx >= 0 && tiersAbove <= 1 && ov + 1 < min) {
    problemsExtra.push(
      `only ${nameOf(config.permissions.vouch)} can /vouch and you have ${ov} override role(s) — ` +
        `reaching the ${min}-vouch minimum may be impossible, which would leave every trial stuck on AWAITING VOUCHES`
    );
  }
}

// ---- sanity ----
console.log(`\n${B}Sanity checks${X}`);
const problems = [...problemsExtra];
const keys = config.ranks.map((r) => r.key);
for (const name of ['manageStaff', 'vouch', 'review']) {
  const val = config.permissions[name];
  if (!keys.includes(val)) problems.push(`permissions.${name} = "${val}" is not one of: ${keys.join(', ')}`);
}
const allRoleIds = config.ranks.map((r) => r.roleId);
if (new Set(allRoleIds).size !== allRoleIds.length) problems.push('two ranks share the same role ID');
if (config.scoring.autoFlag.belowBar >= config.scoring.autoFlag.promote) {
  problems.push('scoring.autoFlag.belowBar must be lower than .promote');
}
if (config.scoring.vouches.passRatio <= 0.5) {
  problems.push('scoring.vouches.passRatio at or below 0.5 means a tied vote passes');
}
for (const cat of tk.categoryIds ?? []) {
  if (!isId(cat) || placeholder(cat)) continue;
  const clash = Object.entries({
    'channels.staffLog': config.channels.staffLog,
    'channels.reviews': config.channels.reviews,
    'announcements.channelId': ann.channelId,
  }).find(([, v]) => String(v) === String(cat));
  if (clash) {
    problems.push(
      `ticketKing.categoryIds contains ${cat}, which is also ${clash[0]} — it must be the CATEGORY Ticket King creates channels in, not a channel`
    );
  }
}
if (problems.length) {
  for (const p of problems) console.log(`   ${R_}✗${X} ${p}`);
} else {
  console.log(`   ${G}✓${X} no logical problems found`);
}

// ---- summary ----
const pct = Math.round((done / required) * 100);
console.log(
  `\n${B}${done}/${required} required values filled in (${pct}%)${X}` +
    (optional ? `${D}, ${optional} optional left blank${X}` : '')
);

if (done === required && !problems.length) {
  console.log(`\n${G}Ready to go.${X} Start the bot, then in Discord:`);
  console.log(`   ${D}/sync${X}   registers your existing staff so tracking begins`);
  if (tk.enabled) {
    console.log(
      `\n${Y}One thing to verify:${X} open a test ticket, claim it, and confirm Staffbot`
    );
    console.log(
      `can still see the channel. Ticket King's claim modes change permissions, and if`
    );
    console.log(`Staffbot loses access your ticket metrics silently read zero.\n`);
  }
  process.exit(0);
} else {
  console.log(`\n${Y}Fill in the ✗ items in config.js and .env, then run this again.${X}`);
  console.log(`${D}Turn on Developer Mode (User Settings > Advanced) to right-click and Copy ID.${X}\n`);
  process.exit(1);
}

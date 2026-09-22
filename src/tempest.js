'use strict';

// Talks to the Tempest Suite Minecraft plugin.
//
// The bot never writes game state itself. It writes a request row, the plugin picks it up,
// decides whether it is allowed and does the work, then writes the answer back on the same
// row. Every rule — who may ban whom, rank protection, the approval queue, the audit trail —
// lives on the plugin side, so there is exactly one copy of it rather than two that drift.
//
// This is a separate database from the bot's own SQLite. The bot's tables are about staff
// performance; these are the server's.

const crypto = require('crypto');
const config = require('../config');

let pool = null;
let mysql = null;
let lastError = null;

// The plugin joins arguments with a unit separator, because a ban reason is free text and
// will contain commas, spaces and newlines.
const SEP = '';

// The statements the bot runs against the plugin's database, exported so the contract
// test executes exactly these rather than a copy that could drift from them.
const SQL = {
  insertCommand:
    `INSERT INTO tempest_command_request
       (request_key, action, discord_id, discord_name, args, confirmed, created_at, status)
     VALUES (?,?,?,?,?,?,?, 'PENDING')`,
  readCommand:
    'SELECT status, result_code, result_message FROM tempest_command_request WHERE id = ?',
  insertLink:
    `INSERT INTO tempest_link_request
       (request_key, action, discord_id, discord_name, payload, created_at, status)
     VALUES (?, 'LINK', ?, ?, ?, ?, 'PENDING')`,
  // discord_id is WHO IS BEING LINKED, same as every other action. The staff member
  // asking for it rides in the payload, because the plugin authorises this against
  // THEIR linked Minecraft account rather than against anything the bot claims.
  insertAdminLink:
    `INSERT INTO tempest_link_request
       (request_key, action, discord_id, discord_name, payload, created_at, status)
     VALUES (?, 'ADMIN_LINK', ?, ?, ?, ?, 'PENDING')`,
  readLink:
    'SELECT status, result_code, result_message FROM tempest_link_request WHERE id = ?',
  readAccount: 'SELECT uuid, name FROM tempest_link WHERE discord_id = ?',
};

function settings() {
  return config.tempest || {};
}

function enabled() {
  return Boolean(settings().enabled);
}

/**
 * The connection details, environment first.
 *
 * config.js is committed to git, so it is the wrong place for any of this — not just the
 * password. The database is reachable from anywhere ("Connections from: %" on a panel),
 * which makes the host and username half of a working credential rather than harmless
 * configuration. Everything here can therefore come from .env, which is not tracked.
 */
function credentials() {
  const s = settings();
  return {
    host: process.env.TEMPEST_DB_HOST || s.host || '127.0.0.1',
    port: Number(process.env.TEMPEST_DB_PORT || s.port || 3306),
    user: process.env.TEMPEST_DB_USER || s.user || '',
    database: process.env.TEMPEST_DB_NAME || s.database || '',
    password: process.env.TEMPEST_DB_PASSWORD || s.password || '',
  };
}

/**
 * Lazily builds the connection pool.
 *
 * Loaded with require() only when actually needed, so a bot running without the Minecraft
 * integration does not have to have mysql2 installed at all.
 */
function connect() {
  if (pool || !enabled()) return pool;
  try {
    // eslint-disable-next-line global-require
    mysql = mysql || require('mysql2/promise');
  } catch (e) {
    lastError = 'mysql2 is not installed. Run: npm install mysql2';
    return null;
  }
  const c = credentials();
  pool = mysql.createPool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    waitForConnections: true,
    connectionLimit: settings().connectionLimit || 4,
    // Keeps a dead connection from hanging an interaction until Discord times it out.
    connectTimeout: settings().connectTimeoutMs || 5000,
  });
  return pool;
}

async function query(sql, params) {
  const p = connect();
  if (!p) throw new Error(lastError || 'The Minecraft integration is turned off.');
  const [rows] = await p.execute(sql, params);
  return rows;
}

/** A fresh idempotency key. A retry with the same key cannot apply the action twice. */
function requestKey() {
  return crypto.randomBytes(16).toString('hex');
}

function encodeArgs(args) {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(SEP);
}

/**
 * Waits for the plugin to answer a row.
 *
 * Polls rather than listens, because MySQL has no push and adding a message broker for this
 * would be a lot of moving parts for a handful of commands a day. The interval is short and
 * the ceiling is well inside Discord's 15-minute deferred-reply window.
 */
async function waitForResult(id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || settings().timeoutMs || 15000);
  const interval = settings().pollIntervalMs || 400;

  for (;;) {
    const rows = await query(SQL.readCommand, [id]);
    const row = rows[0];
    if (row && row.status !== 'PENDING' && row.status !== 'CLAIMED') {
      return {
        ok: row.status === 'OK',
        code: row.result_code,
        message: row.result_message,
      };
    }
    if (Date.now() > deadline) {
      // The row stays PENDING and the plugin may still run it. Say so rather than implying
      // nothing happened — "it timed out" and "it did not happen" are different answers.
      return {
        ok: false,
        code: 'TIMEOUT',
        message:
          'The server did not answer in time. It may still apply — check before retrying.',
      };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Runs a moderation action on the Minecraft server.
 *
 * @param {string} discordId   who is asking
 * @param {string} discordName their display name, for the audit trail
 * @param {string} action      one of the plugin's allowlisted actions
 * @param {object} args        validated on the plugin side, not here
 * @param {boolean} confirmed  the user confirmed a destructive action
 */
async function run(discordId, discordName, action, args, confirmed) {
  const key = requestKey();
  const result = await query(SQL.insertCommand, [
    key, action, discordId, discordName || null,
    encodeArgs(args), confirmed ? 1 : 0, Date.now(),
  ]);
  return waitForResult(result.insertId);
}

/**
 * Redeems a link code.
 *
 * Goes to a different table from run(): a link request arrives from somebody who has no
 * linked account yet, so it cannot be permission-checked the way a command is.
 */
/**
 * Waits for the plugin to answer a row in tempest_link_request.
 *
 * Shared by both link paths: the plugin writes the verdict back onto the same row, so the only
 * difference between redeeming a code and forcing a link is which row was inserted.
 */
async function awaitLinkResult(insertId) {
  const deadline = Date.now() + (settings().timeoutMs || 15000);
  const interval = settings().pollIntervalMs || 400;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await query(SQL.readLink, [insertId]);
    const row = rows[0];
    if (row && row.status !== 'PENDING' && row.status !== 'CLAIMED') {
      return { ok: row.status === 'OK', code: row.result_code, message: row.result_message };
    }
    if (Date.now() > deadline) {
      return { ok: false, code: 'TIMEOUT', message: 'The server did not answer in time.' };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Links someone else's account on a staff member's behalf.
 *
 * The plugin decides whether the staff member may: it checks THEIR linked Minecraft account for
 * tempest.admin.link and refuses otherwise. Being allowed to run the Discord command is not the
 * same as being allowed to change a link, and only one of those two answers survives somebody
 * losing their in-game rank.
 */
async function adminLink(staffDiscordId, targetDiscordId, targetDiscordName, playerName) {
  const key = requestKey();
  const payload = `player=${playerName},actor=${staffDiscordId}`;
  const result = await query(SQL.insertAdminLink, [
    key, targetDiscordId, targetDiscordName || null, payload, Date.now(),
  ]);
  return awaitLinkResult(result.insertId);
}

async function sendLinkCode(discordId, discordName, payload) {
  const result = await query(SQL.insertLink, [
    requestKey(), discordId, discordName || null, payload, Date.now(),
  ]);
  return awaitLinkResult(result.insertId);
}

async function redeemLinkCode(discordId, discordName, code, bypass = false) {
  if (!bypass) {
    return sendLinkCode(discordId, discordName, code);
  }

  // `code=X,bypass=true` carries the exemption the bare code cannot. A server still on
  // the older build reads the whole payload as the code and rejects it, so fall back
  // rather than leaving the exempt people — the owners — as the only ones who cannot
  // link until the plugin is updated. The code is not consumed by a failed attempt, so
  // the retry is free; the cooldown simply is not skipped, which is the lesser loss.
  const result = await sendLinkCode(discordId, discordName, `code=${code},bypass=true`);
  if (result.ok || result.code !== 'INVALID_CODE') {
    return result;
  }
  return sendLinkCode(discordId, discordName, code);
}

/** The Minecraft account a Discord user has linked, or null. */
async function linkedAccount(discordId) {
  const rows = await query(SQL.readAccount, [discordId]);
  return rows[0] || null;
}

/** Checks the connection, for startup diagnostics. */
/**
 * Does a table the bot writes to exist?
 *
 * The plugin creates its tables per feature module, so a database can be
 * perfectly reachable and still be missing the half the bot needs — that is not
 * a connection fault and should not be reported as one.
 */
async function tableExists(name) {
  const rows = await query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1',
    [name]
  );
  return rows.length > 0;
}

async function check() {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  try {
    await query('SELECT 1', []);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  enabled, credentials, tableExists, run, redeemLinkCode, adminLink, linkedAccount, check, close, SEP, SQL, encodeArgs,
  // Exposed so roleSync can write its own desired-state rows without a second pool.
  query,
};

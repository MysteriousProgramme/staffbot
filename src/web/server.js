const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../../config');
const api = require('./api');

/**
 * The dashboard's HTTP layer: auth, static files, and routing into api.js.
 *
 * Served from inside the bot process on purpose. A separate process could read
 * the same SQLite file, but it could not hand someone a role or delete a ticket
 * channel — only the process holding the Discord connection can do that, and
 * "promote" that updates a database but not Discord is worse than no button.
 *
 * There are no dependencies here beyond Node itself. This bot ships three
 * packages in total and runs on a free-tier box; pulling in a web framework and
 * a build step to serve nine endpoints would be the tail wagging the dog.
 */

const W = () => config.web ?? {};
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------

let TOKEN = null;

/** Sessions live in memory, so a restart signs everyone out. That is fine. */
const sessions = new Map(); // id -> expiry ms

// Login attempts per address. The token is long enough that this is belt and
// braces, but an unthrottled password box on a box you tunnel into is a bad
// habit regardless.
const attempts = new Map(); // ip -> { count, until }
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

function resolveToken() {
  const fromEnv = process.env.WEB_TOKEN?.trim();
  if (fromEnv) {
    if (fromEnv.length < 16) {
      console.warn('[web] WEB_TOKEN is short. Use at least 16 characters.');
    }
    return fromEnv;
  }
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Constant-time compare. Plain === leaks how much of the token was right via
 * how long the comparison took, one character at a time.
 */
function tokenMatches(given) {
  if (typeof given !== 'string' || !TOKEN) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function newSession() {
  const id = crypto.randomBytes(24).toString('base64url');
  sessions.set(id, Date.now() + (W().sessionMinutes ?? 720) * 60000);
  return id;
}

function validSession(req) {
  const raw = req.headers.cookie ?? '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith('sb_session='));
  if (!hit) return false;

  const id = hit.slice('sb_session='.length);
  const expires = sessions.get(id);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of sessions) if (exp < now) sessions.delete(id);
  for (const [ip, a] of attempts) if (a.until < now) attempts.delete(ip);
}, 60000).unref();

// ---------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // This page renders staff names, ticket subjects and message samples —
    // all attacker-influenced text. Lock the browser down around it.
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; " +
      // Avatars come from Discord's CDN; everything else stays same-origin.
      "img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; " +
      "form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  // path.join collapses "..", so compare the resolved path against the root
  // rather than trusting the request to be well behaved.
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC)) return send(res, 403, { error: 'no' });

  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, buf, {
      'Content-Type': TYPES[path.extname(full)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
  });
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) {
        reject(new Error('Body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('That was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) => req.socket.remoteAddress ?? 'unknown';

// ---------------------------------------------------------------
// Routing
// ---------------------------------------------------------------

async function handle(req, res, client) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (route === '/api/session') {
    return send(res, 200, { authed: validSession(req), writes: W().allowWrites !== false });
  }

  if (route === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const a = attempts.get(ip);
    if (a && a.count >= MAX_ATTEMPTS && a.until > Date.now()) {
      const mins = Math.ceil((a.until - Date.now()) / 60000);
      return send(res, 429, { error: `Too many attempts. Try again in ${mins} minute(s).` });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }

    if (!tokenMatches(body.token)) {
      const next = { count: (a?.count ?? 0) + 1, until: Date.now() + LOCKOUT_MS };
      attempts.set(ip, next);
      console.warn(`[web] failed login from ${ip} (${next.count}/${MAX_ATTEMPTS})`);
      return send(res, 401, { error: 'Wrong token.' });
    }

    attempts.delete(ip);
    const id = newSession();
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `sb_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
        (W().sessionMinutes ?? 720) * 60
      }`,
    });
  }

  if (route.startsWith('/api/')) {
    if (!validSession(req)) return send(res, 401, { error: 'Not signed in.' });

    if (req.method !== 'GET') {
      if (W().allowWrites === false) {
        return send(res, 403, { error: 'The dashboard is read-only (web.allowWrites is false).' });
      }
      // SameSite=Strict already keeps another site from carrying the cookie,
      // and a custom header cannot be set cross-origin without CORS consent.
      // Together that is enough; a form post from elsewhere cannot do either.
      if (req.headers['x-staffbot'] !== 'dashboard') {
        return send(res, 403, { error: 'Missing dashboard header.' });
      }
    }

    let body = {};
    if (req.method !== 'GET') {
      try {
        body = await readBody(req);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    try {
      const result = await api.route({
        client,
        method: req.method,
        path: route.slice('/api'.length),
        query: url.searchParams,
        body,
      });
      if (result === undefined) return send(res, 404, { error: 'No such endpoint.' });
      return send(res, result.status ?? 200, result.body ?? result);
    } catch (e) {
      console.error(`[web] ${req.method} ${route}:`, e);
      return send(res, e.status ?? 500, { error: String(e.message ?? e) });
    }
  }

  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
  return serveStatic(res, route);
}

// ---------------------------------------------------------------

let server = null;

function start(client) {
  if (!W().enabled) return null;
  if (server) return server;

  TOKEN = resolveToken();

  const host = W().host ?? '127.0.0.1';
  const port = W().port ?? 8787;

  server = http.createServer((req, res) => {
    handle(req, res, client).catch((e) => {
      console.error('[web] unhandled:', e);
      try {
        send(res, 500, { error: 'Something broke. Check the bot console.' });
      } catch {
        /* response already gone */
      }
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(
        `[web] port ${port} is already taken. Change web.port in config.js, or stop whatever else is on it.`
      );
    } else {
      console.error('[web]', e.message);
    }
    server = null;
  });

  server.listen(port, host, () => {
    const local = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`\n[web] dashboard: http://${local}:${port}`);
    console.log(`[web] token: ${TOKEN}`);
    if (!process.env.WEB_TOKEN) {
      console.log('[web] (generated for this run — set WEB_TOKEN in .env to keep one)');
    }
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.warn(
        `[web] WARNING: bound to ${host}, not loopback. This control panel is now reachable\n` +
          '[web] from the network. Unless you meant that, set web.host back to "127.0.0.1"\n' +
          '[web] and reach it over an SSH tunnel instead.'
      );
    }
    if (W().allowWrites === false) console.log('[web] read-only mode');
    console.log('');
  });

  return server;
}

module.exports = { start, tokenMatches, resolveToken };

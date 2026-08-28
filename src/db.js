const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DATA_DIR lets the database live somewhere that survives a redeploy. On a
// host with ephemeral storage this MUST point at a mounted persistent disk —
// otherwise every restart silently wipes the entire staff history.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (process.env.DATA_DIR) console.log(`[db] using ${DATA_DIR}`);

const db = new Database(path.join(DATA_DIR, 'staffbot.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    guild_id         TEXT NOT NULL,
    user_id          TEXT NOT NULL,
    rank_key         TEXT NOT NULL,
    hired_at         INTEGER NOT NULL,
    rank_since       INTEGER NOT NULL,
    last_actor_id    TEXT,
    trial_started_at INTEGER,
    trial_ends_at    INTEGER,
    trial_state      TEXT,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS metrics (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    day      TEXT NOT NULL,
    metric   TEXT NOT NULL,
    value    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, day, metric)
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_lookup ON metrics (guild_id, user_id, metric, day);

  CREATE TABLE IF NOT EXISTS vouches (
    guild_id   TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    voucher_id TEXT NOT NULL,
    cycle      INTEGER NOT NULL,
    verdict    TEXT NOT NULL,
    reason     TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, subject_id, voucher_id, cycle)
  );

  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes (guild_id, subject_id, created_at);

  CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit (guild_id, subject_id, created_at);

  CREATE TABLE IF NOT EXISTS tickets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id          TEXT NOT NULL,
    channel_id        TEXT NOT NULL UNIQUE,
    channel_name      TEXT,
    opener_id         TEXT,
    opened_at         INTEGER NOT NULL,
    last_activity_at  INTEGER NOT NULL,
    claimed_by        TEXT,
    claimed_at        INTEGER,
    first_response_by TEXT,
    first_response_at INTEGER,
    closed_at         INTEGER,
    credited_to       TEXT,
    state             TEXT NOT NULL DEFAULT 'open'
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_open ON tickets (guild_id, state);

  -- Leave of absence. While one is open the person is not chased for being
  -- quiet, and their trial deadline is pushed back by the same number of days.
  CREATE TABLE IF NOT EXISTS loa (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    start_at   INTEGER NOT NULL,
    end_at     INTEGER NOT NULL,
    reason     TEXT,
    created_by TEXT,
    state      TEXT NOT NULL DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_loa_user ON loa (guild_id, user_id, state);

  -- Where and when each staff member is actually present. One row per
  -- person/day/channel/hour, so breadth and coverage are just DISTINCT counts.
  CREATE TABLE IF NOT EXISTS presence (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    day        TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    hour       INTEGER NOT NULL,
    messages   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, day, channel_id, hour)
  );
  CREATE INDEX IF NOT EXISTS idx_presence_window ON presence (guild_id, user_id, day);

  -- A rolling sample of what a person actually said, so a human can read
  -- their tone at review time. Pruned aggressively; see config.conduct.
  CREATE TABLE IF NOT EXISTS conduct (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'discord',
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conduct_user ON conduct (guild_id, user_id, created_at);

  -- Minecraft username -> Discord account, so in-game chat can be attributed
  CREATE TABLE IF NOT EXISTS game_links (
    guild_id   TEXT NOT NULL,
    ign_lower  TEXT NOT NULL,
    ign        TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    linked_by  TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, ign_lower)
  );
  CREATE INDEX IF NOT EXISTS idx_game_links_user ON game_links (guild_id, user_id);

  -- Manual score adjustments. Never deleted, only voided, so an undo still
  -- leaves a record of what was done and by whom.
  CREATE TABLE IF NOT EXISTS adjustments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    points     INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    voided_at  INTEGER,
    voided_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_adjust_user ON adjustments (guild_id, user_id, created_at);

  -- Manual score adjustments. Deliberately a LEDGER, not an edit to the score:
  -- every entry keeps who issued it, why, when it expires and whether it was
  -- revoked, so an adjusted score can always be taken apart again.
  CREATE TABLE IF NOT EXISTS adjustments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    points     INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    revoked_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_adj_user ON adjustments (guild_id, user_id, created_at);

  -- who actually talked in each ticket, and how much
  CREATE TABLE IF NOT EXISTS ticket_participants (
    channel_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    messages   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );
`);


// The built-in ticket system was replaced by the Ticket King watcher.
// CREATE TABLE IF NOT EXISTS will not add columns to a table that already
// exists, so top up anything missing rather than making people delete
// their database (which would take their whole staff history with it).
function ensureColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, decl] of Object.entries(columns)) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      console.log(`[db] migrated: added ${table}.${name}`);
    }
  }
}
ensureColumns('tickets', {
  channel_name: 'TEXT',
  credited_to: 'TEXT',
  last_activity_at: 'INTEGER NOT NULL DEFAULT 0',
});

// Adjustments gained expiry and were renamed void -> revoke. CREATE TABLE IF
// NOT EXISTS silently does nothing to an existing table, so without this the
// bot would throw at require() time on any database that predates the change —
// which takes the whole process down before it ever reaches an error handler.
ensureColumns('adjustments', {
  expires_at: 'INTEGER',
  revoked_at: 'INTEGER',
  revoked_by: 'TEXT',
});
{
  const cols = new Set(db.prepare('PRAGMA table_info(adjustments)').all().map((c) => c.name));
  if (cols.has('voided_at')) {
    const moved = db
      .prepare(
        'UPDATE adjustments SET revoked_at = voided_at, revoked_by = voided_by WHERE voided_at IS NOT NULL AND revoked_at IS NULL'
      )
      .run().changes;
    if (moved) console.log(`[db] migrated: carried ${moved} voided adjustment(s) over to revoked`);
  }
}

const now = () => Date.now();
const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

const stmts = {
  getStaff: db.prepare('SELECT * FROM staff WHERE guild_id = ? AND user_id = ?'),
  listStaff: db.prepare('SELECT * FROM staff WHERE guild_id = ? ORDER BY rank_since DESC'),
  listTrials: db.prepare(
    `SELECT * FROM staff WHERE guild_id = ? AND trial_state IN ('active','midpoint_posted','awaiting_review') ORDER BY trial_ends_at ASC`
  ),
  listAllPendingTrials: db.prepare(
    `SELECT * FROM staff WHERE trial_state IN ('active','midpoint_posted')`
  ),
  upsertStaff: db.prepare(`
    INSERT INTO staff (guild_id, user_id, rank_key, hired_at, rank_since, last_actor_id)
    VALUES (@guild_id, @user_id, @rank_key, @now, @now, @actor_id)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      rank_key = @rank_key, rank_since = @now, last_actor_id = @actor_id
  `),
  deleteStaff: db.prepare('DELETE FROM staff WHERE guild_id = ? AND user_id = ?'),
  setTrial: db.prepare(
    'UPDATE staff SET trial_started_at = ?, trial_ends_at = ?, trial_state = ? WHERE guild_id = ? AND user_id = ?'
  ),
  setTrialState: db.prepare('UPDATE staff SET trial_state = ? WHERE guild_id = ? AND user_id = ?'),
  setTrialEnd: db.prepare('UPDATE staff SET trial_ends_at = ? WHERE guild_id = ? AND user_id = ?'),

  bumpMetric: db.prepare(`
    INSERT INTO metrics (guild_id, user_id, day, metric, value)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, user_id, day, metric) DO UPDATE SET value = value + excluded.value
  `),
  sumMetrics: db.prepare(`
    SELECT metric, SUM(value) AS total FROM metrics
    WHERE guild_id = ? AND user_id = ? AND day >= ? AND day <= ?
    GROUP BY metric
  `),
  activeDays: db.prepare(`
    SELECT COUNT(DISTINCT day) AS days FROM metrics
    WHERE guild_id = ? AND user_id = ? AND day >= ? AND day <= ? AND value > 0
      AND metric NOT IN ('responseTotalSec','responseCount')
  `),

  putVouch: db.prepare(`
    INSERT INTO vouches (guild_id, subject_id, voucher_id, cycle, verdict, reason, created_at)
    VALUES (@guild_id, @subject_id, @voucher_id, @cycle, @verdict, @reason, @created_at)
    ON CONFLICT (guild_id, subject_id, voucher_id, cycle) DO UPDATE SET
      verdict = @verdict, reason = @reason, created_at = @created_at
  `),
  getVouches: db.prepare(
    'SELECT * FROM vouches WHERE guild_id = ? AND subject_id = ? AND cycle = ? ORDER BY created_at ASC'
  ),

  addNote: db.prepare(
    'INSERT INTO notes (guild_id, subject_id, author_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getNotes: db.prepare(
    'SELECT * FROM notes WHERE guild_id = ? AND subject_id = ? ORDER BY created_at DESC LIMIT ?'
  ),
  notesSince: db.prepare(
    `SELECT * FROM notes WHERE guild_id = ? AND subject_id = ? AND kind = ? AND created_at >= ?
     ORDER BY created_at DESC`
  ),

  addAudit: db.prepare(
    'INSERT INTO audit (guild_id, actor_id, subject_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getAudit: db.prepare(
    'SELECT * FROM audit WHERE guild_id = ? AND subject_id = ? ORDER BY created_at DESC LIMIT ?'
  ),

  // ---- tickets (Ticket King watcher) ----
  upsertTicket: db.prepare(`
    INSERT INTO tickets (guild_id, channel_id, channel_name, opener_id, opened_at, last_activity_at)
    VALUES (@guild_id, @channel_id, @channel_name, @opener_id, @opened_at, @opened_at)
    ON CONFLICT (channel_id) DO NOTHING
  `),
  getTicketByChannel: db.prepare('SELECT * FROM tickets WHERE channel_id = ?'),
  listOpenTickets: db.prepare(
    `SELECT * FROM tickets WHERE guild_id = ? AND state = 'open' ORDER BY opened_at ASC`
  ),
  listAllOpenTickets: db.prepare(`SELECT * FROM tickets WHERE state = 'open'`),
  setOpener: db.prepare(
    'UPDATE tickets SET opener_id = ? WHERE channel_id = ? AND opener_id IS NULL'
  ),
  setClaim: db.prepare(
    'UPDATE tickets SET claimed_by = ?, claimed_at = ? WHERE channel_id = ?'
  ),
  setFirstResponse: db.prepare(`
    UPDATE tickets SET first_response_by = ?, first_response_at = ?
    WHERE channel_id = ? AND first_response_at IS NULL
  `),
  touchTicket: db.prepare('UPDATE tickets SET last_activity_at = ? WHERE channel_id = ?'),
  closeTicket: db.prepare(`
    UPDATE tickets SET state = 'closed', closed_at = ?, credited_to = ? WHERE channel_id = ?
  `),
  bumpParticipant: db.prepare(`
    INSERT INTO ticket_participants (channel_id, user_id, messages) VALUES (?, ?, 1)
    ON CONFLICT (channel_id, user_id) DO UPDATE SET messages = messages + 1
  `),
  getParticipants: db.prepare(
    'SELECT * FROM ticket_participants WHERE channel_id = ? ORDER BY messages DESC'
  ),
  ticketStatsFor: db.prepare(`
    SELECT
      COUNT(*) AS handled,
      SUM(CASE WHEN claimed_by = @user THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN first_response_by = @user THEN 1 ELSE 0 END) AS firstReplies
    FROM tickets
    WHERE guild_id = @guild AND state = 'closed'
      AND credited_to = @user
      AND closed_at BETWEEN @from AND @to
  `),
  claimsSeen: db.prepare(
    `SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND claimed_by IS NOT NULL`
  ),

  // ---- leave of absence ----
  startLoa: db.prepare(`
    INSERT INTO loa (guild_id, user_id, start_at, end_at, reason, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  activeLoa: db.prepare(
    `SELECT * FROM loa WHERE guild_id = ? AND user_id = ? AND state = 'active' ORDER BY end_at DESC LIMIT 1`
  ),
  listActiveLoa: db.prepare(`SELECT * FROM loa WHERE guild_id = ? AND state = 'active' ORDER BY end_at`),
  endLoa: db.prepare(`UPDATE loa SET state = 'ended', end_at = ? WHERE id = ?`),
  expireLoa: db.prepare(`UPDATE loa SET state = 'ended' WHERE state = 'active' AND end_at < ?`),
  loaDaysInWindow: db.prepare(`
    SELECT COALESCE(SUM(MIN(end_at, @to) - MAX(start_at, @from)), 0) AS ms
    FROM loa WHERE guild_id = @guild AND user_id = @user AND end_at > @from AND start_at < @to
  `),

  // ---- whole-team queries (leaderboard, coverage) ----
  allTrackedMetrics: db.prepare(`
    SELECT user_id, metric, SUM(value) AS total FROM metrics
    WHERE guild_id = ? AND day >= ? AND day <= ?
    GROUP BY user_id, metric
  `),
  teamHourHistogram: db.prepare(`
    SELECT hour, COUNT(DISTINCT user_id) AS people, SUM(messages) AS messages
    FROM presence WHERE guild_id = ? AND day >= ? AND day <= ?
    GROUP BY hour ORDER BY hour
  `),
  lastSeen: db.prepare(`
    SELECT user_id, MAX(day) AS day FROM presence
    WHERE guild_id = ? GROUP BY user_id
  `),

  // ---- presence (breadth + coverage) ----
  bumpPresence: db.prepare(`
    INSERT INTO presence (guild_id, user_id, day, channel_id, hour, messages)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT (guild_id, user_id, day, channel_id, hour)
      DO UPDATE SET messages = messages + 1
  `),
  breadth: db.prepare(`
    SELECT COUNT(DISTINCT channel_id) AS channels, COUNT(DISTINCT hour) AS hours
    FROM presence WHERE guild_id = ? AND user_id = ? AND day >= ? AND day <= ?
  `),
  topChannels: db.prepare(`
    SELECT channel_id, SUM(messages) AS n FROM presence
    WHERE guild_id = ? AND user_id = ? AND day >= ? AND day <= ?
    GROUP BY channel_id ORDER BY n DESC LIMIT ?
  `),
  hourHistogram: db.prepare(`
    SELECT hour, SUM(messages) AS n FROM presence
    WHERE guild_id = ? AND user_id = ? AND day >= ? AND day <= ?
    GROUP BY hour ORDER BY hour
  `),

  // ---- conduct sample ----
  addConduct: db.prepare(`
    INSERT INTO conduct (guild_id, user_id, channel_id, source, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getConduct: db.prepare(`
    SELECT * FROM conduct WHERE guild_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `),
  countConduct: db.prepare('SELECT COUNT(*) AS n FROM conduct WHERE guild_id = ? AND user_id = ?'),
  trimConduct: db.prepare(`
    DELETE FROM conduct WHERE id IN (
      SELECT id FROM conduct WHERE guild_id = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )
  `),
  purgeConduct: db.prepare('DELETE FROM conduct WHERE created_at < ?'),
  clearConduct: db.prepare('DELETE FROM conduct WHERE guild_id = ? AND user_id = ?'),

  // ---- manual adjustments ----
  addAdjustment: db.prepare(`
    INSERT INTO adjustments (guild_id, user_id, points, reason, author_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  adjustmentsIn: db.prepare(`
    SELECT * FROM adjustments
    WHERE guild_id = ? AND user_id = ? AND voided_at IS NULL
      AND created_at >= ? AND created_at <= ?
    ORDER BY created_at DESC
  `),
  adjustmentsAll: db.prepare(`
    SELECT * FROM adjustments WHERE guild_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `),
  getAdjustment: db.prepare('SELECT * FROM adjustments WHERE id = ? AND guild_id = ?'),
  voidAdjustment: db.prepare(
    'UPDATE adjustments SET voided_at = ?, voided_by = ? WHERE id = ? AND voided_at IS NULL'
  ),

  // ---- manual adjustments ----
  addAdjustment: db.prepare(`
    INSERT INTO adjustments (guild_id, user_id, points, reason, author_id, created_at, expires_at)
    VALUES (@guild_id, @user_id, @points, @reason, @author_id, @created_at, @expires_at)
  `),
  activeAdjustments: db.prepare(`
    SELECT * FROM adjustments
    WHERE guild_id = ? AND user_id = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
  `),
  allAdjustments: db.prepare(`
    SELECT * FROM adjustments WHERE guild_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `),
  getAdjustment: db.prepare('SELECT * FROM adjustments WHERE id = ? AND guild_id = ?'),
  revokeAdjustment: db.prepare(
    'UPDATE adjustments SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL'
  ),

  // ---- game links ----
  putLink: db.prepare(`
    INSERT INTO game_links (guild_id, ign_lower, ign, user_id, linked_by, created_at)
    VALUES (@guild_id, @ign_lower, @ign, @user_id, @linked_by, @created_at)
    ON CONFLICT (guild_id, ign_lower) DO UPDATE SET
      ign = @ign, user_id = @user_id, linked_by = @linked_by, created_at = @created_at
  `),
  getLink: db.prepare('SELECT * FROM game_links WHERE guild_id = ? AND ign_lower = ?'),
  linksForUser: db.prepare(
    'SELECT * FROM game_links WHERE guild_id = ? AND user_id = ? ORDER BY created_at'
  ),
  listLinks: db.prepare('SELECT * FROM game_links WHERE guild_id = ? ORDER BY ign'),
  deleteLink: db.prepare('DELETE FROM game_links WHERE guild_id = ? AND ign_lower = ?'),
};

module.exports = {
  db,
  dayKey,

  getStaff: (g, u) => stmts.getStaff.get(g, u),
  listStaff: (g) => stmts.listStaff.all(g),
  listTrials: (g) => stmts.listTrials.all(g),
  listAllPendingTrials: () => stmts.listAllPendingTrials.all(),

  setRank(guildId, userId, rankKey, actorId) {
    const existing = stmts.getStaff.get(guildId, userId);
    stmts.upsertStaff.run({
      guild_id: guildId,
      user_id: userId,
      rank_key: rankKey,
      now: now(),
      actor_id: actorId,
    });
    return existing;
  },

  removeStaff: (g, u) => stmts.deleteStaff.run(g, u),

  startTrial(guildId, userId, endsAt) {
    stmts.setTrial.run(now(), endsAt, 'active', guildId, userId);
  },
  setTrialState: (g, u, state) => stmts.setTrialState.run(state, g, u),
  setTrialEnd: (g, u, ts) => stmts.setTrialEnd.run(ts, g, u),
  clearTrial: (g, u, outcome) => stmts.setTrialState.run(outcome, g, u),

  bumpMetric(guildId, userId, metric, amount = 1) {
    stmts.bumpMetric.run(guildId, userId, dayKey(), metric, amount);
  },

  /** Totals for a window. from/to are ms timestamps. */
  getMetrics(guildId, userId, from, to) {
    const a = dayKey(from);
    const b = dayKey(to);
    const rows = stmts.sumMetrics.all(guildId, userId, a, b);

    const out = {
      modActions: 0,
      ticketsHandled: 0,
      inGameActivity: 0,
      staffPresence: 0,
      publicActivity: 0,
      responseTotalSec: 0,
      responseCount: 0,
    };
    for (const r of rows) out[r.metric] = r.total;

    out.activeDays = stmts.activeDays.get(guildId, userId, a, b)?.days ?? 0;

    const br = stmts.breadth.get(guildId, userId, a, b);
    out.channelBreadth = br?.channels ?? 0;
    out.activeHours = br?.hours ?? 0;

    // Average first-response time, in minutes. null when they've never
    // been first to reply — scoring skips the metric rather than scoring 0.
    out.responseSpeed =
      out.responseCount > 0 ? out.responseTotalSec / out.responseCount / 60 : null;

    return out;
  },

  putVouch(guildId, subjectId, voucherId, cycle, verdict, reason) {
    stmts.putVouch.run({
      guild_id: guildId,
      subject_id: subjectId,
      voucher_id: voucherId,
      cycle,
      verdict,
      reason: reason || null,
      created_at: now(),
    });
  },
  getVouches: (g, s, cycle) => stmts.getVouches.all(g, s, cycle),

  addNote: (g, s, a, kind, body) => stmts.addNote.run(g, s, a, kind, body, now()),
  getNotes: (g, s, limit = 10) => stmts.getNotes.all(g, s, limit),
  /** Notes of one kind since a timestamp — used to tell whether anyone acted. */
  notesSince: (g, s, kind, since) => stmts.notesSince.all(g, s, kind, since),

  addAudit: (g, actor, subject, action, detail) =>
    stmts.addAudit.run(g, actor, subject, action, detail || null, now()),
  getAudit: (g, s, limit = 10) => stmts.getAudit.all(g, s, limit),

  // ---------------- tickets (Ticket King watcher) ----------------

  /** Register a ticket channel we have just noticed. Idempotent. */
  noteTicketOpened({ guildId, channelId, channelName, openerId, openedAt }) {
    stmts.upsertTicket.run({
      guild_id: guildId,
      channel_id: channelId,
      channel_name: channelName ?? null,
      opener_id: openerId ?? null,
      opened_at: openedAt ?? now(),
    });
    return stmts.getTicketByChannel.get(channelId);
  },

  getTicket: (channelId) => stmts.getTicketByChannel.get(channelId),
  listOpenTickets: (g) => stmts.listOpenTickets.all(g),
  listAllOpenTickets: () => stmts.listAllOpenTickets.all(),

  setOpener: (channelId, userId) => stmts.setOpener.run(userId, channelId),
  setClaim: (channelId, userId) => stmts.setClaim.run(userId, now(), channelId),
  touchTicket: (channelId) => stmts.touchTicket.run(now(), channelId),
  bumpParticipant: (channelId, userId) => stmts.bumpParticipant.run(channelId, userId),
  getParticipants: (channelId) => stmts.getParticipants.all(channelId),

  /** Records the first staff reply and returns the wait in seconds, or null. */
  recordFirstResponse(ticket, userId) {
    const res = stmts.setFirstResponse.run(userId, now(), ticket.channel_id);
    if (res.changes === 0) return null;
    return Math.max(0, Math.round((now() - ticket.opened_at) / 1000));
  },

  closeTicket: (channelId, creditedTo) =>
    stmts.closeTicket.run(now(), creditedTo ?? null, channelId),

  ticketStatsFor: (guild, user, from, to) => stmts.ticketStatsFor.get({ guild, user, from, to }),

  /** Have we ever successfully detected a Ticket King claim? */
  claimsSeen: (guildId) => stmts.claimsSeen.get(guildId).n,

  // ---------------- leave of absence ----------------
  startLoa(guildId, userId, days, reason, by) {
    const now_ = now();
    stmts.startLoa.run(guildId, userId, now_, now_ + days * 86400000, reason ?? null, by ?? null);
    return stmts.activeLoa.get(guildId, userId);
  },
  activeLoa: (g, u) => stmts.activeLoa.get(g, u),
  listActiveLoa: (g) => stmts.listActiveLoa.all(g),
  endLoa(id) {
    stmts.endLoa.run(now(), id);
  },
  /** Close out any LOA whose end date has passed. Returns how many. */
  expireLoa: () => stmts.expireLoa.run(now()).changes,
  /** Days of LOA overlapping a window — used to explain a quiet scorecard. */
  loaDaysInWindow(guild, user, from, to) {
    const ms = stmts.loaDaysInWindow.get({ guild, user, from, to })?.ms ?? 0;
    return Math.max(0, Math.round(ms / 86400000));
  },

  // ---------------- whole-team ----------------
  allTrackedMetrics(guildId, from, to) {
    const rows = stmts.allTrackedMetrics.all(guildId, dayKey(from), dayKey(to));
    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, {});
      byUser.get(r.user_id)[r.metric] = r.total;
    }
    return byUser;
  },
  teamHourHistogram: (g, from, to) => stmts.teamHourHistogram.all(g, dayKey(from), dayKey(to)),
  lastSeen(guildId) {
    const map = new Map();
    for (const r of stmts.lastSeen.all(guildId)) map.set(r.user_id, r.day);
    return map;
  },

  // ---------------- presence ----------------
  bumpPresence(guildId, userId, channelId, ts = Date.now()) {
    stmts.bumpPresence.run(guildId, userId, dayKey(ts), channelId, new Date(ts).getUTCHours());
  },
  topChannels: (g, u, from, to, limit = 5) =>
    stmts.topChannels.all(g, u, dayKey(from), dayKey(to), limit),
  hourHistogram: (g, u, from, to) => stmts.hourHistogram.all(g, u, dayKey(from), dayKey(to)),

  // ---------------- conduct sample ----------------
  addConduct(guildId, userId, channelId, source, content, keep) {
    stmts.addConduct.run(guildId, userId, channelId, source, content, now());
    if (keep > 0) stmts.trimConduct.run(guildId, userId, keep);
  },
  getConduct: (g, u, limit = 25) => stmts.getConduct.all(g, u, limit),
  countConduct: (g, u) => stmts.countConduct.get(g, u).n,
  clearConduct: (g, u) => stmts.clearConduct.run(g, u),
  purgeConduct: (olderThanMs) => stmts.purgeConduct.run(olderThanMs).changes,

  // ---------------- manual adjustments ----------------
  addAdjustment(guildId, userId, points, reason, authorId) {
    const r = stmts.addAdjustment.run(guildId, userId, points, reason, authorId, now());
    return r.lastInsertRowid;
  },
  /** Adjustments that fall inside a scoring window. Voided ones are excluded. */
  adjustmentsIn: (g, u, from, to) => stmts.adjustmentsIn.all(g, u, from, to),
  adjustmentsAll: (g, u, limit = 15) => stmts.adjustmentsAll.all(g, u, limit),
  getAdjustment: (id, g) => stmts.getAdjustment.get(id, g),
  voidAdjustment: (id, g, by) => {
    const row = stmts.getAdjustment.get(id, g);
    if (!row || row.voided_at) return null;
    stmts.voidAdjustment.run(now(), by, id);
    return row;
  },

  // ---------------- manual adjustments ----------------
  addAdjustment({ guildId, userId, points, reason, authorId, expiresAt }) {
    const info = stmts.addAdjustment.run({
      guild_id: guildId,
      user_id: userId,
      points,
      reason,
      author_id: authorId,
      created_at: now(),
      expires_at: expiresAt ?? null,
    });
    return stmts.getAdjustment.get(info.lastInsertRowid, guildId);
  },
  activeAdjustments: (g, u) => stmts.activeAdjustments.all(g, u, now()),
  allAdjustments: (g, u, limit = 20) => stmts.allAdjustments.all(g, u, limit),
  getAdjustment: (id, g) => stmts.getAdjustment.get(id, g),
  revokeAdjustment: (id, g, by) => {
    const row = stmts.getAdjustment.get(id, g);
    if (!row) return null;
    if (stmts.revokeAdjustment.run(now(), by, id).changes === 0) return null;
    return row;
  },

  // ---------------- Minecraft name links ----------------
  linkGameName(guildId, ign, userId, linkedBy) {
    stmts.putLink.run({
      guild_id: guildId,
      ign_lower: String(ign).toLowerCase(),
      ign: String(ign),
      user_id: userId,
      linked_by: linkedBy ?? null,
      created_at: now(),
    });
  },
  /** Resolve a Minecraft username to a Discord user ID, or null. */
  resolveGameName: (guildId, ign) =>
    stmts.getLink.get(guildId, String(ign).toLowerCase())?.user_id ?? null,
  linksForUser: (g, u) => stmts.linksForUser.all(g, u),
  listLinks: (g) => stmts.listLinks.all(g),
  unlinkGameName: (g, ign) => stmts.deleteLink.run(g, String(ign).toLowerCase()).changes > 0,
};

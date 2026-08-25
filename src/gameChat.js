const config = require('../config');
const db = require('./db');
const observe = require('./observe');

/**
 * In-game chat bridge.
 *
 * Your Discord channel mirrors Minecraft chat. Those messages are posted by
 * the bridge, not by the staff member's Discord account, so the author gives
 * us nothing — we have to work out who is talking from the Minecraft name and
 * a mapping built with /link.
 *
 * Two ways the name arrives:
 *
 *   1. WEBHOOK. Most bridges impersonate the player, so the webhook's username
 *      IS the Minecraft name. Nothing to parse, and nothing to break when the
 *      bridge changes its formatting. Tried first.
 *   2. Plain bot message with the name in the text ("<Steve> hi"). Falls back
 *      to config.gameChat.namePattern.
 *
 * This is the only metric that shows whether a trial actually plays on the
 * server, which on an SMP is most of the job.
 */

const GC = () => config.gameChat;

const isChannel = (channelId) =>
  Boolean(GC()?.enabled) && String(channelId) === String(GC()?.channelId);

let nameRe;
let ignoreRe;

function compiled(which) {
  const cache = which === 'name' ? nameRe : ignoreRe;
  if (cache !== undefined) return cache;
  const src = which === 'name' ? GC()?.namePattern : GC()?.ignorePattern;
  let re = false;
  if (src) {
    try {
      re = new RegExp(src, which === 'name' ? '' : 'i');
    } catch (e) {
      console.error(`[gamechat] ${which}Pattern is not a valid regex: ${e.message}`);
      re = false;
    }
  }
  if (which === 'name') nameRe = re;
  else ignoreRe = re;
  return re;
}

/** Server broadcasts, join/leave spam, death messages — not a person talking. */
function isNoise(text) {
  const re = compiled('ignore');
  return re ? re.test(text) : false;
}

/**
 * Pull the Minecraft username out of a bridge message.
 * Returns { ign, body } or null.
 */
function extract(message) {
  const content = message.content ?? '';

  // 1. Webhook impersonation — the reliable path.
  if (message.webhookId) {
    const ign = (message.author?.username ?? '').trim();
    if (/^[A-Za-z0-9_]{3,16}$/.test(ign)) return { ign, body: content };
  }

  // 2. Name embedded in the text (DiscordSRV's default bot delivery).
  const re = compiled('name');
  if (re) {
    const m = content.match(re);
    if (m?.[1]) return { ign: m[1], body: content.slice(m[0].length) };
  }

  // 3. Loose fallback for nicknames the strict pattern can't express: take
  //    whatever sits immediately before the separator. This is safe precisely
  //    because a name still has to resolve through /link to count for anything
  //    — a bad guess just fails the lookup and is discarded.
  if (GC()?.looseFallback) {
    const sep = content.search(/[»>]/);
    if (sep > 0 && sep < 60) {
      const left = content
        .slice(0, sep)
        .replace(/\*\*[^*]*\*\*/g, ' ') // drop the bolded rank prefix
        .replace(/[*_~`\[\]]/g, ' ')
        .trim();
      const last = left.split(/\s+/).filter(Boolean).pop();
      if (last && last.length >= 3 && last.length <= 32) {
        return { ign: last, body: content.slice(sep + 1) };
      }
    }
  }

  return null;
}

/**
 * Called from tracking.js. Returns true if this message was in the bridge
 * channel, so the ordinary activity tracker skips it — otherwise the bridge
 * bot itself would be the most active "staff member" in the server.
 */
function handleMessage(message) {
  if (!isChannel(message.channelId)) return false;

  try {
    const content = message.content ?? '';
    if (isNoise(content)) return true;

    const hit = extract(message);
    if (!hit) return true;

    const userId = db.resolveGameName(message.guildId, hit.ign);
    if (!userId) return true; // unlinked player, or just a member playing
    if (!db.getStaff(message.guildId, userId)) return true;

    // Same anti-farming floor as everywhere else: "gg" is not presence.
    const body = (hit.body ?? '').trim();
    if (body.length < (config.tracking?.minMessageLength ?? 5)) return true;

    // How staff talk to players in-game is often the clearest read on tone,
    // so this feeds the conduct sample even though it is not a Discord channel.
    if (config.conduct?.includeGameChat) {
      observe.noteConduct(message.guildId, userId, message.channelId, body, 'minecraft');
    }

    if (onCooldown(userId)) return true;

    db.bumpMetric(message.guildId, userId, 'inGameActivity');
  } catch (e) {
    console.error('[gamechat] error:', e.message);
  }

  return true;
}

// All in-game chat arrives through one channel, so the per-channel cooldown
// used elsewhere would be a per-person global throttle here. Same idea,
// tracked per linked user.
const cooldowns = new Map();
function onCooldown(userId) {
  const window = (config.tracking?.messageCooldownSeconds ?? 45) * 1000;
  const last = cooldowns.get(userId) ?? 0;
  if (Date.now() - last < window) return true;
  cooldowns.set(userId, Date.now());
  return false;
}
setInterval(() => {
  const cutoff = Date.now() - (config.tracking?.messageCooldownSeconds ?? 45) * 4000;
  for (const [k, v] of cooldowns) if (v < cutoff) cooldowns.delete(k);
}, 10 * 60 * 1000).unref();

/** Startup summary so an unlinked team is obvious on day one. */
function report(client) {
  if (!GC()?.enabled) return;
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const links = db.listLinks(guild.id);
  const staff = db.listStaff(guild.id);
  const linkedStaff = new Set(links.map((l) => l.user_id));
  const missing = staff.filter((s) => !linkedStaff.has(s.user_id)).length;

  console.log(
    `[gamechat] bridge channel set · ${links.length} name(s) linked · ` +
      `${missing} staff member(s) with no Minecraft name` +
      (missing ? ' — they will score 0 for in-game presence until /link is run' : '')
  );
}

module.exports = { handleMessage, extract, isNoise, report, isChannel };

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const db = require('./db');
const R = require('./ranks');
const team = require('./team');
const { postToReviews } = require('./util');

/**
 * The weekly digest.
 *
 * Everything here is something the bot already knows and nobody was asking
 * it. That is the whole value: a staff system that only answers when
 * questioned will let a trial quietly expire, a moderator quietly drift away,
 * and a ticket sit unclaimed for four days. This turns the bot from a
 * reference into something that taps you on the shoulder.
 */

const D = () => config.digest ?? {};

function build(guild) {
  const days = D().windowDays ?? 7;
  const from = Date.now() - days * 86400000;
  const embed = new EmbedBuilder()
    .setColor(config.colors.neutral)
    .setTitle(`Staff digest — last ${days} days`)
    .setTimestamp();

  let anythingUrgent = false;

  // ---- trials that need a decision or are about to ----
  const trials = db.listTrials(guild.id);
  if (trials.length) {
    const soon = Date.now() + (D().trialWarningDays ?? 3) * 86400000;
    const lines = trials.map((t) => {
      const due = t.trial_ends_at ? `<t:${Math.floor(t.trial_ends_at / 1000)}:R>` : 'no end date';
      if (t.trial_state === 'awaiting_review') {
        anythingUrgent = true;
        return `🔔 <@${t.user_id}> — **waiting on a decision**`;
      }
      if (t.trial_ends_at && t.trial_ends_at < soon) {
        anythingUrgent = true;
        return `⏳ <@${t.user_id}> — ends ${due}, get vouches in`;
      }
      return `• <@${t.user_id}> — ends ${due}`;
    });
    embed.addFields({ name: `Trials (${trials.length})`, value: lines.join('\n').slice(0, 1020) });
  }

  // ---- people who have gone quiet ----
  const quietDays = D().quietAfterDays ?? 10;
  const gone = team.quiet(guild.id, quietDays);
  if (gone.length) {
    anythingUrgent = true;
    embed.addFields({
      name: `⚠️ Quiet for ${quietDays}+ days (${gone.length})`,
      value:
        gone
          .slice(0, 10)
          .map(
            (q) =>
              `<@${q.userId}> · ${q.rankName} — ${
                q.lastSeen ? `last seen ${q.lastSeen}` : 'never seen'
              }`
          )
          .join('\n')
          .slice(0, 900) + '\n\n_Anyone on leave is excluded. `/loa start` if they told you._',
    });
  }

  // ---- tickets sitting around ----
  const open = db.listOpenTickets(guild.id);
  if (open.length) {
    const unclaimed = open.filter((t) => !t.claimed_by);
    const noReply = open.filter((t) => !t.first_response_at);
    if (unclaimed.length || noReply.length) anythingUrgent = true;
    embed.addFields({
      name: `Tickets (${open.length} open)`,
      value:
        `**${unclaimed.length}** unclaimed · **${noReply.length}** with no staff reply yet` +
        (noReply.length
          ? '\n' +
            noReply
              .slice(0, 5)
              .map((t) => `⚠️ <#${t.channel_id}> — opened <t:${Math.floor(t.opened_at / 1000)}:R>`)
              .join('\n')
          : ''),
    });
  }

  // ---- hours nobody covers ----
  const cov = team.coverage(guild.id, from, Date.now());
  if (cov.gaps.length) {
    embed.addFields({
      name: 'Coverage gaps',
      value:
        `\`${cov.bar}\`\n\`0     6     12    18  23\`\n` +
        cov.gaps.slice(0, 6).map(team.fmtGap).join(' · ') +
        '\n_Hours with nobody around. Useful when deciding who to hire next._',
    });
  }

  // ---- leaderboard, only if you asked for it ----
  if (D().includeLeaderboard) {
    const board = team.leaderboard(guild.id, from, Date.now());
    if (board.length) {
      embed.addFields({
        name: 'Scores this week',
        value: board
          .slice(0, 10)
          .map((r, i) => `\`${String(i + 1).padStart(2)}\` <@${r.userId}> — **${r.score}**${r.onLoa ? ' _(leave)_' : ''}`)
          .join('\n')
          .slice(0, 1020),
      });
    }
  }

  if (!embed.data.fields?.length) {
    embed.setDescription('Nothing needs attention. No trials running, nobody quiet, no stale tickets.');
  }

  embed.setFooter({
    text: anythingUrgent
      ? 'Items marked ⚠️ or 🔔 want a human this week'
      : 'Nothing urgent',
  });

  return { embed, anythingUrgent };
}

/** Post it now, regardless of schedule. Used by /digest. */
async function post(guild) {
  const { embed } = build(guild);
  const ping = D().pingRoleId ? `<@&${D().pingRoleId}>` : undefined;
  return postToReviews(guild, {
    content: ping,
    embeds: [embed],
    allowedMentions: { roles: D().pingRoleId ? [D().pingRoleId] : [] },
  });
}

/**
 * Fire once a week, at a set hour UTC. Checked every 15 minutes rather than
 * with a precise timer, because the process restarts and a missed timer is a
 * missed week — a cheap poll that survives reboots is worth more than an
 * elegant schedule that doesn't.
 */
function start(client) {
  if (!D().enabled) {
    console.log('[digest] weekly digest is off');
    return;
  }
  const wantDay = D().dayOfWeek ?? 1; // 0 Sun … 1 Mon
  const wantHour = D().hourUTC ?? 9;
  let lastKey = null;

  const tick = async () => {
    try {
      db.expireLoa(); // close out any leave that has run its course

      const now = new Date();
      if (now.getUTCDay() !== wantDay || now.getUTCHours() !== wantHour) return;

      const key = now.toISOString().slice(0, 10);
      if (key === lastKey) return; // already posted today
      lastKey = key;

      for (const guild of client.guilds.cache.values()) {
        await post(guild);
        console.log(`[digest] posted for ${guild.name}`);
      }
    } catch (e) {
      console.error('[digest]', e.message);
    }
  };

  setInterval(tick, 15 * 60 * 1000);
  setTimeout(tick, 20000);
  console.log(
    `[digest] on — ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wantDay]} ${String(wantHour).padStart(2, '0')}:00 UTC`
  );
}

module.exports = { start, post, build };

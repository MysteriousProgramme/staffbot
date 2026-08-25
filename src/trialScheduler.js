const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const db = require('./db');
const { buildReviewCard } = require('./reviewCard');
const { postToReviews, tryDM } = require('./util');

/**
 * Periodically checks for trials hitting their midpoint or their end date,
 * and posts the scorecard automatically so nobody's trial quietly expires.
 */
function start(client) {
  const intervalMs = Math.max(1, config.trial.checkIntervalMinutes) * 60000;
  const tick = () => check(client).catch((e) => console.error('[trials] check failed:', e));
  setTimeout(tick, 10000); // first run shortly after boot
  setInterval(tick, intervalMs);
  console.log(`[trials] watcher running every ${config.trial.checkIntervalMinutes}m`);
}

async function check(client) {
  const rows = db.listAllPendingTrials();
  const now = Date.now();

  for (const row of rows) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;

    const user = await client.users.fetch(row.user_id).catch(() => null);
    if (!user) continue;

    // ----- midpoint -----
    const frac = config.trial.midpointCheckAt;
    if (
      frac &&
      row.trial_state === 'active' &&
      row.trial_started_at &&
      row.trial_ends_at &&
      now >= row.trial_started_at + (row.trial_ends_at - row.trial_started_at) * frac
    ) {
      const { embed } = buildReviewCard(guild, row, user, { midpoint: true });
      await postToReviews(guild, { embeds: [embed] });
      db.setTrialState(row.guild_id, row.user_id, 'midpoint_posted');
      continue;
    }

    // ----- end of trial -----
    if (row.trial_ends_at && now >= row.trial_ends_at) {
      const { embed, v } = buildReviewCard(guild, row, user);

      await postToReviews(guild, {
        content: `<@&${resolveVouchPing()}> — **${user.username}**'s trial is up.`,
        embeds: [embed],
        allowedMentions: { roles: [resolveVouchPing()].filter(Boolean) },
      });

      db.setTrialState(row.guild_id, row.user_id, 'awaiting_review');
      db.addAudit(row.guild_id, client.user.id, row.user_id, 'trial_expired', v.label);

      await tryDM(user, {
        embeds: [
          new EmbedBuilder()
            .setColor(config.colors.neutral)
            .setTitle(`Your trial in ${guild.name} has finished`)
            .setDescription(
              'Senior staff are reviewing it now and will let you know shortly. Thanks for putting the time in.'
            ),
        ],
      });
    }
  }
}

/** Ping the lowest rank allowed to vouch, so the right people see the card. */
function resolveVouchPing() {
  const rank = config.ranks.find((r) => r.key === config.permissions.vouch);
  return rank?.roleId ?? null;
}

module.exports = { start };

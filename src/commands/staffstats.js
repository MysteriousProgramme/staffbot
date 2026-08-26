const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const standing = require('../standing');
const { err, ok } = require('../util');
const { computeScore } = require('../scoring');

const TRIAL_STATES = ['active', 'midpoint_posted', 'awaiting_review'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staffstats')
    .setDescription('Raw tracked numbers for a staff member over any window')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('days')
        .setDescription('How far back to look (default: their rank window)')
        .setMinValue(1)
        .setMaxValue(365)
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }

    const user = interaction.options.getUser('user');
    const row = db.getStaff(interaction.guildId, user.id);
    if (!row) return err(interaction, `**${user.username}** isn't tracked as staff.`);

    const rank = R.rankByKey(row.rank_key);
    const onTrial = TRIAL_STATES.includes(row.trial_state ?? '');

    // Default to the window this person is actually judged over, rather than a
    // flat 30 for everybody. A trial is judged over the trial.
    const defaultDays = onTrial
      ? config.trial.defaultDays
      : standing.enabled()
        ? standing.windowDaysFor(row.rank_key)
        : 30;
    const days = interaction.options.getInteger('days') ?? defaultDays;

    const from = Date.now() - days * 86400000;
    const metrics = db.getMetrics(interaction.guildId, user.id, from, Date.now());

    // WHICH YARDSTICK. This is the whole point of the command and getting it
    // wrong is worse than showing no score at all: measuring a Head Mod
    // against 14-day trial targets reads as ~100%, and the footer below tells
    // you to calibrate config.js from what you see. You'd end up raising your
    // trial bar off a number that was never measuring a trial.
    const profile = onTrial || !standing.enabled() ? null : standing.scaledProfile(row.rank_key, days);
    const { score, breakdown } = computeScore(metrics, profile);

    const yardstick = profile
      ? `**${rank?.name ?? row.rank_key}** targets` +
        (days === standing.windowDaysFor(row.rank_key) ? '' : `, scaled to ${days} days`)
      : `**trial** targets (written for ${config.trial.defaultDays} days)`;

    const embed = new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setAuthor({ name: `${user.username} — last ${days} days`, iconURL: user.displayAvatarURL() })
      .setDescription(
        `Rank: **${rank?.name ?? row.rank_key}** since <t:${Math.floor(row.rank_since / 1000)}:D>` +
          (onTrial ? ' · **on trial**' : '') +
          `\nScored against ${yardstick}: **${score}/100**`
      )
      .addFields(
        ...breakdown.map((b) => ({
          name: b.label,
          value: `**${b.display}** \`${b.bar}\`\n${b.direction === 'lower' ? 'aim under' : 'target'} ${b.targetDisplay}`,
          inline: true,
        }))
      );

    // A trial member measured over a window that isn't their trial length is
    // being compared to targets written for a different period. Say so rather
    // than letting the percentage quietly lie.
    if (!profile && !onTrial && standing.enabled()) {
      embed.addFields({
        name: '⚠️ No rank profile',
        value: `There is no \`standing.profiles.${row.rank_key}\` entry, so this fell back to trial targets. Add one, or the score above flatters them.`,
      });
    } else if (!profile && onTrial && days !== config.trial.defaultDays) {
      embed.addFields({
        name: 'Note',
        value: `The trial targets cover ${config.trial.defaultDays} days and you asked for ${days}. The raw numbers are right; the percentages are stretched.`,
      });
    }

    if (!onTrial && standing.enabled()) {
      const holdBar = config.standing.holdBar ?? 45;
      const promoteBar = config.standing.promoteBar ?? 80;
      embed.addFields({
        name: 'Against their bars',
        value:
          `Hold **${holdBar}** · Promote **${promoteBar}** — they are at **${score}**\n` +
          `_Raw numbers only. \`/review user:@${user.username}\` for trajectory, time in rank, vouches and the verdict._`,
      });
    }

    if (config.ticketKing?.enabled) {
      const ts = db.ticketStatsFor(interaction.guildId, user.id, from, Date.now());
      embed.addFields({
        name: 'Ticket work (Ticket King)',
        value:
          `Credited with **${ts?.handled ?? 0}** ticket(s) · claimed **${ts?.claimed ?? 0}** · ` +
          `first to reply on **${ts?.firstReplies ?? 0}**` +
          (metrics.responseSpeed !== null
            ? `\nAvg first reply **${Math.round(metrics.responseSpeed)} min** across ${metrics.responseCount} ticket(s)`
            : '\nNever first to reply'),
      });
    }

    if (config.gameChat?.enabled) {
      const links = db.linksForUser(interaction.guildId, user.id);
      embed.addFields({
        name: 'Minecraft',
        value: links.length
          ? links.map((l) => `\`${l.ign}\``).join(', ')
          : '⚠️ **No name linked** — in-game presence will read 0 for them. Run `/link set`.',
      });
    }

    // With the private staff-log channel switched off, this is now the only
    // place the reasons behind past rank changes can be read back.
    const history = db.getAudit(interaction.guildId, user.id, 8);
    if (history.length) {
      embed.addFields({
        name: 'Recent rank history',
        value: history
          .map((h) => `<t:${Math.floor(h.created_at / 1000)}:d> **${h.action}** — ${h.detail ?? ''}`)
          .join('\n')
          .slice(0, 1020),
      });
    }

    // Calibration advice has to point at the block that actually produced the
    // numbers above, or it sends you to edit the wrong ones.
    embed.setFooter({
      text: profile
        ? `Calibrating? These are standing.profiles.${row.rank_key} in config.js`
        : 'Calibrating your trial targets? Run this on a trusted staff member with days:' +
          config.trial.defaultDays +
          ' — that edits scoring.metrics',
    });

    return ok(interaction, embed, { ephemeral: true });
  },
};

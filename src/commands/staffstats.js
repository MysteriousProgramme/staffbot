const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, ok } = require('../util');
const { computeScore } = require('../scoring');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staffstats')
    .setDescription('Raw tracked numbers for a staff member over any window')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('days')
        .setDescription('How far back to look (default 30)')
        .setMinValue(1)
        .setMaxValue(365)
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }

    const user = interaction.options.getUser('user');
    const days = interaction.options.getInteger('days') ?? 30;
    const row = db.getStaff(interaction.guildId, user.id);
    if (!row) return err(interaction, `**${user.username}** isn't tracked as staff.`);

    const from = Date.now() - days * 86400000;
    const metrics = db.getMetrics(interaction.guildId, user.id, from, Date.now());
    const { score, breakdown } = computeScore(metrics);
    const rank = R.rankByKey(row.rank_key);

    const embed = new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setAuthor({ name: `${user.username} — last ${days} days`, iconURL: user.displayAvatarURL() })
      .setDescription(
        `Rank: **${rank?.name ?? row.rank_key}** since <t:${Math.floor(row.rank_since / 1000)}:D>\n` +
          `Equivalent trial score over this window: **${score}/100**`
      )
      .addFields(
        ...breakdown.map((b) => ({
          name: b.label,
          value: `**${b.display}** \`${b.bar}\`\n${b.direction === 'lower' ? 'aim under' : 'target'} ${b.targetDisplay}`,
          inline: true,
        }))
      )
      .setFooter({
        text: 'Use this on a mod you already trust to calibrate your targets in config.js',
      });

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

    return ok(interaction, embed, { ephemeral: true });
  },
};

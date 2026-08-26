const { SlashCommandBuilder } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const standing = require('../standing');
const { err, ok } = require('../util');
const { buildReviewCard, buildStandingCard } = require('../reviewCard');

const TRIAL_STATES = ['active', 'midpoint_posted', 'awaiting_review'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('review')
    .setDescription('Show the full scorecard for a staff member')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('window')
        .setDescription('Days to look back (ranked staff only — default is the rank window)')
        .setMinValue(7)
        .setMaxValue(365)
    )
    .addBooleanOption((o) =>
      o
        .setName('public')
        .setDescription('Post it visibly instead of only to you (default: only you)')
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }

    const user = interaction.options.getUser('user');
    const isPublic = interaction.options.getBoolean('public') ?? false;
    const window = interaction.options.getInteger('window');

    const row = db.getStaff(interaction.guildId, user.id);
    if (!row) {
      return err(
        interaction,
        `**${user.username}** isn't tracked as staff. If they were given a rank by hand rather than with \`/trial start\` or \`/promote\`, the bot has no history for them — use \`/sync\` to register them.`
      );
    }

    // One command, two questions. On a trial the question is "does this end
    // in a promotion?" — after it, the question is "are they holding the rank,
    // and are they ready for the next?". Making the staff member pick the
    // right command for someone else's employment status would be a silly
    // thing to ask of them, so the bot works it out.
    const onTrial = TRIAL_STATES.includes(row.trial_state ?? '');

    if (onTrial) {
      const { embed } = buildReviewCard(interaction.guild, row, user);
      return ok(interaction, embed, { ephemeral: !isPublic });
    }

    if (!standing.enabled()) {
      const { embed } = buildReviewCard(interaction.guild, row, user);
      return ok(interaction, embed, { ephemeral: !isPublic });
    }

    const { embed } = buildStandingCard(interaction.guild, row, user, { days: window ?? null });
    return ok(interaction, embed, { ephemeral: !isPublic });
  },
};

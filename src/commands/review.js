const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, ok } = require('../util');
const { buildReviewCard } = require('../reviewCard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('review')
    .setDescription('Show the full scorecard for a staff member')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
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

    const row = db.getStaff(interaction.guildId, user.id);
    if (!row) {
      return err(
        interaction,
        `**${user.username}** isn't tracked as staff. If they were given a rank by hand rather than with \`/trial start\` or \`/promote\`, the bot has no history for them — use \`/sync\` to register them.`
      );
    }

    const { embed } = buildReviewCard(interaction.guild, row, user);
    return ok(interaction, embed, { ephemeral: !isPublic });
  },
};

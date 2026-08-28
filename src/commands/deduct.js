const { SlashCommandBuilder } = require('discord.js');
const { buildAdjust } = require('../adjustCommand');

/**
 * Take points off someone's score, for something the metrics cannot see.
 *
 * The command that most needed a guardrail. See src/adjustments.js for why
 * this is a ledger entry rather than an edit to the number.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('deduct')
    .setDescription('Take points off a staff member for something the numbers cannot see')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('points')
        .setDescription('How many points to remove')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(50)
    )
    .addStringOption((o) =>
      o
        .setName('reason')
        .setDescription('Why — shown on their card and sent to them')
        .setRequired(true)
        .setMaxLength(300)
    )
    .addIntegerOption((o) =>
      o
        .setName('days')
        .setDescription('Days before it lapses (default 90, 0 = never)')
        .setMinValue(0)
        .setMaxValue(365)
    ),

  execute: (interaction) => buildAdjust(interaction, -1),
};

const { SlashCommandBuilder } = require('discord.js');
const { buildAdjust } = require('../adjustCommand');

/**
 * Add points for work the bot genuinely cannot see.
 *
 * The more defensible half of the pair, and the one worth reaching for first:
 * the bot's blindness cuts both ways. A dispute settled in DMs, an hour spent
 * training a new hire in voice, a build that took somebody a weekend — none of
 * it registers as a single tracked event.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('increase')
    .setDescription('Add points for work the bot cannot see — DMs, voice, builds, mentoring')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('points')
        .setDescription('How many points to add')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(50)
    )
    .addStringOption((o) =>
      o
        .setName('reason')
        .setDescription('What they did — shown on their card and sent to them')
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

  execute: (interaction) => buildAdjust(interaction, +1),
};

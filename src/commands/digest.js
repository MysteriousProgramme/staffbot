const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const R = require('../ranks');
const digest = require('../digest');
const { err } = require('../util');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('digest')
    .setDescription("Post the staff digest now, without waiting for the weekly one")
    .addBooleanOption((o) =>
      o
        .setName('preview')
        .setDescription('Show it only to me instead of posting it to the reviews channel')
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }

    const preview = interaction.options.getBoolean('preview') ?? false;
    const { embed } = digest.build(interaction.guild);

    if (preview) {
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const posted = await digest.post(interaction.guild);
    return interaction.reply({
      content: posted
        ? `Digest posted in <#${config.channels.reviews}>.`
        : 'Could not reach the reviews channel — check `channels.reviews` in config.js.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

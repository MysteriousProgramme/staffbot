const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err } = require('../util');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('note')
    .setDescription('Log something a staff member did well or badly — shows on their review card')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('kind')
        .setDescription('Type of note')
        .setRequired(true)
        .addChoices(
          { name: 'Praise — did something well', value: 'praise' },
          { name: 'Concern — needs correcting', value: 'concern' }
        )
    )
    .addStringOption((o) =>
      o.setName('note').setDescription('What happened').setRequired(true).setMaxLength(400)
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }

    const user = interaction.options.getUser('user');
    const kind = interaction.options.getString('kind');
    const body = interaction.options.getString('note');

    if (!db.getStaff(interaction.guildId, user.id)) {
      return err(interaction, `**${user.username}** isn't tracked as staff.`);
    }

    db.addNote(interaction.guildId, user.id, interaction.user.id, kind, body);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(kind === 'praise' ? config.colors.promote : config.colors.borderline)
          .setDescription(
            `${kind === 'praise' ? '🟢 Praise' : '🟠 Concern'} logged for <@${user.id}>.\n\n> ${body}`
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

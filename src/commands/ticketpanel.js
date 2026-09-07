const { SlashCommandBuilder, ChannelType, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const R = require('../ranks');
const tickets = require('../tickets');
const ticketPanel = require('../ticketPanel');
const { err } = require('../util');

/**
 * Posts the dropdown people open tickets from.
 *
 * The panel message is disposable — nothing is stored against it, and its
 * dropdown works purely off config. Post it again after changing the ticket
 * types and delete the old one; there is no "the" panel to keep track of.
 */

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Post the ticket panel people open tickets from')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Where to post it (defaults to here)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    ),

  async execute(interaction) {
    if (!config.tickets?.enabled) {
      return err(interaction, 'The ticket system is turned off in config.js.');
    }
    if (!R.meetsRequirement(interaction.member, config.permissions.manageStaff)) {
      return err(
        interaction,
        `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to post the panel.`
      );
    }

    // Nothing else will complain until somebody actually picks an option and
    // the channel creation fails, so say it here where it is fixable.
    const unconfigured = (config.tickets.types ?? []).filter((t) => !t.categoryId);
    if (unconfigured.length) {
      return err(
        interaction,
        `These ticket types have no \`categoryId\` in config.js: **${unconfigured
          .map((t) => t.key)
          .join(', ')}**.\nTickets would be created loose at the top of the server. Set them first.`
      );
    }
    if (!(config.tickets.staffRoleIds ?? []).length) {
      return err(
        interaction,
        '`tickets.staffRoleIds` is empty, so nobody but the opener could see a ticket. Set it in config.js first.'
      );
    }

    const target = interaction.options.getChannel('channel') ?? interaction.channel;

    await target.send(ticketPanel.buildPanel(interaction.guild));

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.colors.promote)
          .setDescription(
            `✅ Panel posted in <#${target.id}> with ${config.tickets.types.length} ticket type(s).` +
              (config.tickets.logChannelId
                ? ''
                : '\n\n⚠️ `tickets.logChannelId` is not set, so closed tickets will be deleted **without a transcript**.')
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const { SlashCommandBuilder, ChannelType, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const R = require('../ranks');
const applications = require('../applications');
const db = require('../db');
const { err } = require('../util');

/**
 * Posts a panel people act on.
 *
 * A subcommand group rather than a second /ticketpanel, because panels keep being
 * added and a command per panel is a command list nobody can read. The ticket panel
 * keeps its own command: it is stateless and disposable, and this one is neither.
 */

module.exports = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post a panel people act on')
    .addSubcommand((s) =>
      s
        .setName('applications')
        .setDescription('Post the panel people apply through')
        .addStringOption((o) =>
          o
            .setName('kind')
            .setDescription('Which application (defaults to the first one)')
            .setAutocomplete(true)
        )
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Where to post it (defaults to here)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    ),

  async autocomplete(interaction) {
    const typed = (interaction.options.getFocused() || '').toLowerCase();
    return interaction.respond(
      applications
        .kinds()
        .filter((k) => k.key.includes(typed) || k.name.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((k) => ({ name: k.name.slice(0, 100), value: k.key }))
    );
  },

  async execute(interaction) {
    if (!applications.enabled()) {
      return err(interaction, 'The application system is turned off in config.js.');
    }
    if (!R.meetsRequirement(interaction.member, config.permissions.manageStaff)) {
      return err(
        interaction,
        `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to post a panel.`
      );
    }

    const key = interaction.options.getString('kind');
    const kind = key ? applications.kindByKey(key) : applications.kinds()[0];
    if (!kind) {
      return err(interaction, `There is no application called \`${key}\` in config.js.`);
    }

    // Nothing else complains until somebody actually applies and the submission
    // vanishes, so say it here where it is still fixable.
    if (!kind.pendingChannelId) {
      return err(
        interaction,
        `\`applications.kinds.${kind.key}.pendingChannelId\` is not set, so applications would `
          + 'have nowhere to go. Set it in config.js first.'
      );
    }

    const target = interaction.options.getChannel('channel') ?? interaction.channel;
    const message = await target.send(applications.buildPanel(interaction.guild, kind));

    // Remembered so /application open and close can edit it later. The ticket panel
    // needs no equivalent because it never changes after it is posted.
    db.rememberAppPanel(interaction.guildId, kind.key, target.id, message.id);

    const open = db.applicationsOpen(interaction.guildId, kind.key);
    const missing = ['acceptedChannelId', 'deniedChannelId'].filter((f) => !kind[f]);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.colors.promote)
          .setDescription(
            `✅ **${kind.name}** panel posted in <#${target.id}>.\n`
              + `Currently **${open ? 'OPEN' : 'CLOSED'}** — `
              + `change it with \`/application ${open ? 'close' : 'open'}\`.`
              + (missing.length
                ? `\n\n⚠️ \`${missing.join('` and `')}\` not set, so decided applications `
                  + 'stay in the pending channel instead of moving out of it.'
                : '')
              + (kind.acceptedRoleId ? '' : '\n\n⚠️ `acceptedRoleId` not set, so accepting gives no role.')
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

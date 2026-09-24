const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const R = require('../ranks');
const applications = require('../applications');
const db = require('../db');
const { err } = require('../util');

/**
 * Opens and closes applications.
 *
 * The state is a database row, not a config edit, because this is run mid-season by
 * people who do not touch files — and because a restart must not quietly reopen
 * something that was closed on purpose.
 *
 * Every panel that has been posted is rewritten, so there is no way to close
 * applications and leave a panel somewhere still saying OPEN with a working button.
 */

module.exports = {
  data: new SlashCommandBuilder()
    .setName('application')
    .setDescription('Open or close applications')
    .addSubcommand((s) =>
      s
        .setName('open')
        .setDescription('Start accepting applications')
        .addStringOption((o) =>
          o
            .setName('kind')
            .setDescription('Which application (defaults to the first one)')
            .setAutocomplete(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('close')
        .setDescription('Stop accepting applications')
        .addStringOption((o) =>
          o
            .setName('kind')
            .setDescription('Which application (defaults to the first one)')
            .setAutocomplete(true)
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
        `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to do that.`
      );
    }

    const open = interaction.options.getSubcommand() === 'open';
    const key = interaction.options.getString('kind');
    const kind = key ? applications.kindByKey(key) : applications.kinds()[0];
    if (!kind) {
      return err(interaction, `There is no application called \`${key}\` in config.js.`);
    }

    const already = db.applicationsOpen(interaction.guildId, kind.key) === open;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    db.setApplicationsOpen(interaction.guildId, kind.key, open, interaction.user.id);

    // Run even when the state did not change: a panel posted while it was already
    // closed still needs its button greyed out, and this is the only thing that does it.
    const { edited, forgotten } = await applications.refreshPanels(
      interaction.client, interaction.guild, kind
    );

    const lines = [
      `**${kind.name}** ${open ? 'are now **OPEN**' : 'are now **CLOSED**'}.`,
    ];
    if (already) {
      lines.push(`_They were already ${open ? 'open' : 'closed'} — panels refreshed anyway._`);
    }
    lines.push(
      edited === 0
        ? '\n⚠️ No panels to update. Post one with `/panel applications`.'
        : `\nUpdated ${edited} panel${edited === 1 ? '' : 's'}.`
    );
    if (forgotten) {
      lines.push(`_${forgotten} panel${forgotten === 1 ? ' was' : 's were'} deleted, so ${forgotten === 1 ? 'it is' : 'they are'} no longer tracked._`);
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(open ? config.colors.promote : config.colors.neutral)
          .setDescription(lines.join('\n')),
      ],
    });
  },
};

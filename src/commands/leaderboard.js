const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const R = require('../ranks');
const team = require('../team');
const { err, ok } = require('../util');

const MEDAL = ['🥇', '🥈', '🥉'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Staff ranked by score over a window')
    .addIntegerOption((o) =>
      o.setName('days').setDescription('Window (default 30)').setMinValue(1).setMaxValue(365)
    )
    .addBooleanOption((o) =>
      o
        .setName('public')
        .setDescription('Post it visibly instead of only to you (think first)')
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }

    const days = interaction.options.getInteger('days') ?? 30;
    const isPublic = interaction.options.getBoolean('public') ?? false;
    const from = Date.now() - days * 86400000;

    const rows = team.leaderboard(interaction.guildId, from, Date.now());
    if (!rows.length) {
      return err(interaction, 'Nobody is tracked as staff yet. Run `/sync` first.');
    }

    const lines = rows.slice(0, 20).map((r, i) => {
      const medal = MEDAL[i] ?? `\`${String(i + 1).padStart(2)}\``;
      const tags = [
        r.onTrial ? 'trial' : null,
        r.onLoa ? 'on leave' : null,
      ].filter(Boolean);
      return (
        `${medal} <@${r.userId}> — **${r.score}** · ${r.rankName}` +
        (tags.length ? ` _(${tags.join(', ')})_` : '')
      );
    });

    const embed = new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setTitle(`Staff scores — last ${days} days`)
      .setDescription(lines.join('\n'));

    // The bottom of any leaderboard is the actionable half. Say what is
    // actually weak rather than leaving it as a name in last place.
    const strugglers = rows.filter((r) => !r.onLoa).slice(-3).reverse();
    if (rows.length > 3 && strugglers.length) {
      embed.addFields({
        name: 'Where the bottom of the table is losing points',
        value: strugglers
          .map((r) =>
            r.weakest
              ? `<@${r.userId}> — weakest is **${r.weakest.label}** (${r.weakest.display} of ${r.weakest.targetDisplay})`
              : `<@${r.userId}> — no data yet`
          )
          .join('\n'),
      });
    }

    embed.setFooter({
      text:
        'A score is a prompt to look, not a verdict. Someone quiet who handles the hard tickets ' +
        'will sit mid-table and still be your best moderator.',
    });

    return ok(interaction, embed, { ephemeral: !isPublic });
  },
};

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const R = require('../ranks');
const standing = require('../standing');
const { err, ok } = require('../util');

/**
 * The whole ranked team in one view: who is ready to move up, who is close,
 * and who has been under the bar long enough to be worth asking about.
 *
 * The weekly digest posts this unprompted, which is the version that actually
 * changes behaviour. This is for the moment somebody asks "so who's next?"
 * in a staff meeting and nobody can remember.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('promotions')
    .setDescription('Who is ready to move up, who is close, and who is slipping'),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }
    if (!standing.enabled()) {
      return err(
        interaction,
        'The standing system is switched off. Set `standing.enabled: true` in config.js.'
      );
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const w = standing.watch(interaction.guildId);
    const embed = new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setTitle('Promotion watch')
      .setTimestamp();

    if (w.ready.length) {
      embed.addFields({
        name: `⬆️ Ready (${w.ready.length})`,
        value: w.ready
          .slice(0, 10)
          .map(
            (a) =>
              `<@${a.userId}> · **${a.rank?.name}** → **${a.next.name}**\n` +
              ` ${a.score}/100 · ${a.tenureDays}d in rank · vouched ${a.vouches.yes}–${a.vouches.no}`
          )
          .join('\n')
          .slice(0, 1020),
      });
    }

    if (w.candidates.length) {
      embed.addFields({
        name: `Close (${w.candidates.length})`,
        value: w.candidates
          .slice(0, 10)
          .map((a) => {
            const blocker =
              a.verdict.code === 'too_soon'
                ? `needs ${a.tenureNeeded - a.tenureDays} more day(s) in rank`
                : `needs ${Math.max(0, config.scoring.vouches.minimum - a.vouches.total)} more vouch(es)`;
            return `<@${a.userId}> · ${a.rank?.name} — ${a.score}/100, ${blocker}`;
          })
          .join('\n')
          .slice(0, 1020),
      });
    }

    if (w.drifting.length) {
      embed.addFields({
        name: `📉 Slipping (${w.drifting.length})`,
        value: w.drifting
          .slice(0, 10)
          .map(
            (a) =>
              `<@${a.userId}> · ${a.rank?.name} — ${a.score}/100` +
              (a.previous ? ` (was ${a.previous.score})` : '') +
              (a.breakdown[0] ? ` · weakest: ${a.breakdown[0].label}` : '')
          )
          .join('\n')
          .slice(0, 1020),
      });
    }

    if (!embed.data.fields?.length) {
      embed.setDescription(
        'Nobody is over the promote bar and nobody is under the hold bar two windows running. ' +
          'That is what a settled staff team looks like — it is not the bot failing to find anything.'
      );
    } else {
      embed.setFooter({
        text: 'Recommendations only · /review someone for the full card before deciding',
      });
    }

    return ok(interaction, embed, { ephemeral: true });
  },
};

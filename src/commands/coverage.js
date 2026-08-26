const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const R = require('../ranks');
const team = require('../team');
const { err, ok } = require('../util');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coverage')
    .setDescription('When the team is actually around — and the hours nobody covers')
    .addIntegerOption((o) =>
      o.setName('days').setDescription('Window to look at (default 14)').setMinValue(1).setMaxValue(90)
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }

    const days = interaction.options.getInteger('days') ?? 14;
    const from = Date.now() - days * 86400000;
    const { hours, bar, gaps, maxPeople } = team.coverage(interaction.guildId, from, Date.now());

    const total = hours.reduce((s, h) => s + h.messages, 0);
    if (!total) {
      return err(
        interaction,
        'No presence data yet. This fills in as staff talk — give it a few days.'
      );
    }

    const embed = new EmbedBuilder()
      .setColor(gaps.length ? config.colors.borderline : config.colors.promote)
      .setTitle(`Team coverage — last ${days} days`)
      .setDescription(
        `\`${bar}\`\n\`0     6     12    18  23\`\n` +
          `_hour of day, UTC · height = how many different staff were around_`
      );

    if (gaps.length) {
      embed.addFields({
        name: `⚠️ ${gaps.length} gap${gaps.length === 1 ? '' : 's'} with nobody around`,
        value:
          gaps.map(team.fmtGap).join('\n') +
          '\n\nThis is the most useful thing on this card when you are deciding who to hire next.',
      });
    } else {
      embed.addFields({
        name: '✅ Every hour has someone',
        value: 'No dead hours in this window.',
      });
    }

    const busiest = [...hours].sort((a, b) => b.people - a.people).slice(0, 3);
    embed.addFields({
      name: 'Busiest hours',
      value: busiest
        .map((h) => `\`${String(h.hour).padStart(2, '0')}:00\` — ${h.people} staff around`)
        .join('\n'),
    });

    embed.setFooter({ text: `Peak was ${maxPeople} staff in one hour` });
    return ok(interaction, embed, { ephemeral: true });
  },
};

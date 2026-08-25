const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const observe = require('../observe');
const { err, ok } = require('../util');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('conduct')
    .setDescription('Read a sample of what someone has actually been saying')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName('lines')
        .setDescription('How many lines to show (default 15)')
        .setMinValue(1)
        .setMaxValue(25)
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }
    if (!config.conduct?.enabled) {
      return err(interaction, 'Conduct sampling is turned off in `config.js`.');
    }

    const user = interaction.options.getUser('user');
    const want = interaction.options.getInteger('lines') ?? 15;

    const total = db.countConduct(interaction.guildId, user.id);
    if (!total) {
      const onTrial = observe.isOnTrial(interaction.guildId, user.id);
      return err(
        interaction,
        `Nothing sampled for **${user.username}** yet.` +
          (config.conduct.onlyDuringTrial && !onTrial
            ? '\n\nSampling only runs for people currently on a trial — that\'s the `conduct.onlyDuringTrial` setting.'
            : ' They may simply not have said anything since the bot started watching.')
      );
    }

    const rows = db.getConduct(interaction.guildId, user.id, want);
    const body = rows
      .map((r) => {
        const where = r.source === 'minecraft' ? '⛏️ in-game' : `<#${r.channel_id}>`;
        return `<t:${Math.floor(r.created_at / 1000)}:t> ${where}\n> ${r.content.slice(0, 180)}`;
      })
      .join('\n');

    return ok(
      interaction,
      new EmbedBuilder()
        .setColor(config.colors.neutral)
        .setAuthor({ name: `${user.username} — recent lines`, iconURL: user.displayAvatarURL() })
        .setDescription(body.slice(0, 4000))
        .setFooter({
          text: `${rows.length} of ${total} stored · kept ${config.conduct.retentionDays} days · read it before judging tone`,
        }),
      { ephemeral: true }
    );
  },
};

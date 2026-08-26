const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, ok } = require('../util');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Register everyone who already holds a rank role so the bot starts tracking them'),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.manageStaff)) {
      return err(interaction, `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to run this.`);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const members = await interaction.guild.members.fetch();
    let added = 0;
    let updated = 0;
    let untracked = 0;
    const found = [];

    for (const member of members.values()) {
      if (member.user.bot) continue;
      const idx = R.memberRankIndex(member);
      if (idx < 0) continue;

      const existing = db.getStaff(interaction.guildId, member.id);

      // Owners and Founders often wear a rank role for the colour. They are
      // not on the ladder, so drop them back out rather than scoring them.
      if (!R.isTracked(member)) {
        if (existing) {
          db.removeStaff(interaction.guildId, member.id);
          untracked++;
          found.push(`− <@${member.id}> no longer tracked (holds an override role)`);
        }
        continue;
      }

      const rankKey = R.ranks[idx].key;

      if (!existing) {
        db.setRank(interaction.guildId, member.id, rankKey, interaction.user.id);
        added++;
        found.push(`+ <@${member.id}> → ${R.ranks[idx].name}`);
      } else if (existing.rank_key !== rankKey) {
        db.setRank(interaction.guildId, member.id, rankKey, interaction.user.id);
        updated++;
        found.push(`~ <@${member.id}> ${existing.rank_key} → ${R.ranks[idx].name}`);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setTitle('Sync complete')
      .setDescription(
        `**${added}** newly registered, **${updated}** corrected` +
          (untracked ? `, **${untracked}** dropped as leadership` : '') +
          `.\n\n` +
          (found.length ? found.slice(0, 25).join('\n') : 'Everyone was already up to date.')
      )
      .setFooter({
        text: 'Tracking starts now — existing staff have no back-history, which is expected.',
      });

    return ok(interaction, embed, { ephemeral: true });
  },
};

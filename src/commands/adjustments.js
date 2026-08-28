const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const adj = require('../adjustments');
const { err, ok, tryDM } = require('../util');

/**
 * Read the ledger, and take entries back off it.
 *
 * Revoking matters as much as issuing. An adjustment applied in anger, or one
 * whose cause has since been resolved, should be removable by the same people
 * who could apply it — and the record should show that it was removed rather
 * than quietly vanishing.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('adjustments')
    .setDescription('Review a staff member’s manual score adjustments, or revoke one')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addIntegerOption((o) =>
      o.setName('revoke').setDescription('Entry number to revoke (from the list)').setMinValue(1)
    ),

  async execute(interaction) {
    const user = interaction.options.getUser('user');
    const revokeId = interaction.options.getInteger('revoke');

    // Reading is a review permission; revoking moves someone's standing, so
    // it sits with the commands that manage staff.
    const needed = revokeId ? config.permissions.manageStaff : config.permissions.review;
    if (!R.meetsRequirement(interaction.member, needed)) {
      return err(interaction, revokeId ? 'Only senior staff can revoke an adjustment.' : 'Staff only.');
    }

    if (revokeId) {
      const existing = db.getAdjustment(revokeId, interaction.guildId);
      if (!existing) return err(interaction, `There is no adjustment #${revokeId} in this server.`);
      if (existing.user_id !== user.id) {
        return err(
          interaction,
          `Adjustment #${revokeId} belongs to <@${existing.user_id}>, not <@${user.id}>. Check the number.`
        );
      }
      if (existing.revoked_at) return err(interaction, `Adjustment #${revokeId} was already revoked.`);

      db.revokeAdjustment(revokeId, interaction.guildId, interaction.user.id);
      db.addAudit(
        interaction.guildId,
        interaction.user.id,
        user.id,
        'adjust_revoke',
        `#${revokeId} (${existing.points > 0 ? '+' : ''}${existing.points}): ${existing.reason}`
      );

      if (config.adjustments?.notifySubject !== false && existing.points < 0) {
        await tryDM(user, {
          embeds: [
            new EmbedBuilder()
              .setColor(config.colors.promote)
              .setTitle(`A deduction was lifted in ${interaction.guild.name}`)
              .setDescription(
                `The **${existing.points} point** adjustment for "${existing.reason}" has been revoked. ` +
                  'It no longer affects your score.'
              ),
          ],
        });
      }

      const after = adj.net(interaction.guildId, user.id);
      return ok(
        interaction,
        new EmbedBuilder()
          .setColor(config.colors.promote)
          .setDescription(
            `✅ Revoked #${revokeId} (**${existing.points > 0 ? '+' : ''}${existing.points}**) for <@${user.id}>.\n\n` +
              `Net adjustment is now **${after.delta > 0 ? '+' : ''}${after.delta}**.\n\n` +
              '_The entry stays in the record marked revoked, rather than disappearing._'
          ),
        { ephemeral: true }
      );
    }

    const rows = db.allAdjustments(interaction.guildId, user.id, 20);
    const embed = new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setAuthor({ name: `${user.username} — score adjustments`, iconURL: user.displayAvatarURL() });

    if (!rows.length) {
      embed.setDescription(
        'No adjustments have ever been made to their score. Their number is entirely what the bot measured.'
      );
      return ok(interaction, embed, { ephemeral: true });
    }

    const now = Date.now();
    const state = (r) => {
      if (r.revoked_at) return `~~revoked by <@${r.revoked_by}>~~`;
      if (r.expires_at && r.expires_at <= now) return '_lapsed_';
      return r.expires_at ? `active, lapses <t:${Math.floor(r.expires_at / 1000)}:R>` : '**active, permanent**';
    };

    embed.setDescription(
      rows
        .map(
          (r) =>
            `**#${r.id}** \`${r.points > 0 ? '+' : ''}${r.points}\` by <@${r.author_id}> ` +
            `<t:${Math.floor(r.created_at / 1000)}:d> — ${state(r)}\n${r.reason.slice(0, 160)}`
        )
        .join('\n\n')
        .slice(0, 3800)
    );

    const net = adj.net(interaction.guildId, user.id);
    embed.addFields({
      name: 'Currently applied',
      value:
        `**${net.delta > 0 ? '+' : ''}${net.delta}** points from ${net.rows.length} active entr${
          net.rows.length === 1 ? 'y' : 'ies'
        }` +
        (net.wasCapped ? ` — ${net.raw} before the ±${adj.maxTotal()} cap` : '') +
        (net.rows.some((r) => r.points < 0) &&
        config.adjustments?.deductionBlocksPromotion !== false
          ? '\n⚠️ An active deduction is blocking any promotion recommendation.'
          : ''),
    });

    embed.setFooter({ text: 'Revoke one with /adjustments user:… revoke:<number>' });
    return ok(interaction, embed, { ephemeral: true });
  },
};

const { EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const db = require('./db');
const R = require('./ranks');
const adjustments = require('./adjustments');
const { err, tryDM } = require('./util');

/**
 * Shared body for /deduct and /increase. One implementation, so the two can
 * never drift apart on permissions, limits, notification or wording — and so
 * a guard added to one is a guard on both.
 */
async function buildAdjust(interaction, sign) {
  const actor = interaction.member;

  // Same gate as /promote and /demote. This moves someone's standing; it
  // belongs with the commands that move their rank, not with the read-only ones.
  if (!R.meetsRequirement(actor, config.permissions.manageStaff)) {
    return err(interaction, 'Only senior staff can adjust scores.');
  }
  if (!adjustments.enabled()) {
    return err(interaction, 'Manual adjustments are switched off — set `adjustments.enabled: true` in config.js.');
  }

  const user = interaction.options.getUser('user');
  const magnitude = interaction.options.getInteger('points');
  const reason = interaction.options.getString('reason');
  const days = interaction.options.getInteger('days');
  const points = sign * Math.abs(magnitude);

  if (user.id === interaction.user.id) {
    return err(interaction, "You can't adjust your own score.");
  }

  const target = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!target) return err(interaction, `**${user.username}** isn't in the server.`);

  // The rank rule that applies everywhere else applies here too. Without it,
  // /deduct would be a way to act on a peer that /demote explicitly forbids.
  const blocked = R.checkActionAllowed(actor, target, null);
  if (blocked) return err(interaction, blocked);

  const row = db.getStaff(interaction.guildId, user.id);
  if (!row) {
    return err(
      interaction,
      `**${user.username}** isn't tracked as staff, so there is no score to adjust. Run \`/sync\` if they hold a rank role.`
    );
  }

  const problem = adjustments.validate(points, reason);
  if (problem) return err(interaction, problem);

  // Warn when this entry is doing nothing because the cap already absorbed it.
  const before = adjustments.net(interaction.guildId, user.id);

  const entry = db.addAdjustment({
    guildId: interaction.guildId,
    userId: user.id,
    points,
    reason: reason.trim(),
    authorId: interaction.user.id,
    expiresAt: adjustments.expiryFor(days),
  });

  const after = adjustments.net(interaction.guildId, user.id);
  const landed = after.delta - before.delta;

  db.addAudit(
    interaction.guildId,
    interaction.user.id,
    user.id,
    points < 0 ? 'deduct' : 'increase',
    `${points > 0 ? '+' : ''}${points}: ${reason.trim()}`
  );

  // Telling them is not optional courtesy — a deduction they discover from a
  // number at their next review, months later, is the worst version of this.
  let dmed = false;
  if (config.adjustments?.notifySubject !== false) {
    dmed = await tryDM(user, {
      embeds: [
        new EmbedBuilder()
          .setColor(points < 0 ? config.colors.demote : config.colors.promote)
          .setTitle(
            points < 0
              ? `A deduction was applied to your staff score in ${interaction.guild.name}`
              : `Extra credit was added to your staff score in ${interaction.guild.name}`
          )
          .setDescription(
            `**${points > 0 ? '+' : ''}${points} points** — ${reason.trim()}\n\n` +
              (entry.expires_at
                ? `This lapses on its own <t:${Math.floor(entry.expires_at / 1000)}:R>.`
                : 'This does not expire.') +
              (points < 0
                ? '\n\nThis is not a demotion and it is not a warning on its own. If you think it is wrong, say so — it can be revoked.'
                : '')
          ),
      ],
    });
  }

  const bits = [];
  if (landed !== points) {
    bits.push(
      `⚠️ Only **${landed}** of that landed — the ±${adjustments.maxTotal()} total cap is already reached. ` +
        'If they need moving further than the cap allows, `/demote` is the honest tool.'
    );
  }
  if (entry.expires_at) {
    bits.push(`Lapses <t:${Math.floor(entry.expires_at / 1000)}:R>.`);
  } else {
    bits.push('⚠️ Set to **never expire**. Consider a `days:` value — permanent entries get forgotten.');
  }
  bits.push(dmed ? 'They have been told.' : "Couldn't DM them — their DMs are closed, so tell them yourself.");
  if (points < 0 && config.adjustments?.deductionBlocksPromotion !== false) {
    bits.push('While this is active they cannot be flagged ready for promotion, whatever they score.');
  }

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(points < 0 ? config.colors.demote : config.colors.promote)
        .setDescription(
          `✅ **${points > 0 ? '+' : ''}${points}** for <@${user.id}> — ${reason.trim()}\n\n` +
            `Their net adjustment is now **${after.delta > 0 ? '+' : ''}${after.delta}** ` +
            `across ${after.rows.length} active entr${after.rows.length === 1 ? 'y' : 'ies'}.\n\n` +
            bits.map((b) => `_${b}_`).join('\n')
        )
        .setFooter({ text: `Entry #${entry.id} · /adjustments to review or revoke` }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { buildAdjust };

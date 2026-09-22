'use strict';

// Shared body for the Minecraft moderation commands.
//
// Every one of them does the same four things: check the integration is on, defer (the plugin
// is polled, so this is never instant), run the action, report what came back. The only
// differences are the action name and which options it takes, so they live in one place.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } =
  require('discord.js');
const config = require('../config');
const tempest = require('./tempest');
const db = require('./db');

const COLORS = config.colors || {};

/**
 * Adds the options an action takes.
 *
 * Declared in the order they read best, then sorted so every required option
 * comes first. Discord rejects the whole command otherwise — and it rejects it
 * at registration, which takes the rest of the deploy down with it. That bit
 * everything with a duration AND a required reason: ban, ipban and mute all
 * came out required/optional/required.
 *
 * The partition is stable, so options keep their declared order within each
 * group; only the groups move.
 */
function applyOptions(builder, { player = true, duration = false, reason = 'required' }) {
  const options = [];

  if (player) {
    options.push({
      name: 'player',
      description: 'Minecraft username',
      required: true,
      minLength: 1,
      maxLength: 16,
    });
  }
  if (duration) {
    options.push({
      name: 'duration',
      description: 'e.g. 30m, 12h, 7d — leave blank for permanent',
      required: false,
    });
  }
  if (reason !== 'none') {
    options.push({
      name: 'reason',
      description: 'Why — shown to them and recorded',
      required: reason === 'required',
      maxLength: 300,
    });
  }

  for (const opt of [...options.filter((o) => o.required), ...options.filter((o) => !o.required)]) {
    builder.addStringOption((o) => {
      o.setName(opt.name).setDescription(opt.description).setRequired(opt.required);
      if (opt.minLength) o.setMinLength(opt.minLength);
      if (opt.maxLength) o.setMaxLength(opt.maxLength);
      return o;
    });
  }

  return builder;
}

/**
 * Builds one command.
 *
 * `destructive` mirrors the plugin's own flag. The plugin refuses an unconfirmed destructive
 * action outright, so this is not the security boundary — it is the part that makes sure a
 * human saw what they were about to do.
 */
function build({ name, description, action, duration = false, reason = 'required', destructive = false }) {
  const data = new SlashCommandBuilder().setName(name).setDescription(description);
  applyOptions(data, { duration, reason });

  return {
    data,

    async execute(interaction) {
      if (!tempest.enabled()) {
        return interaction.reply({
          content:
            'The Minecraft integration is turned off. Set `tempest.enabled` in the config.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const args = {
        player: interaction.options.getString('player'),
        duration: duration ? interaction.options.getString('duration') || '' : undefined,
        reason: interaction.options.getString('reason') || '',
      };

      if (destructive) {
        return confirmThenRun(interaction, { name, action, args });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return finish(interaction, { name, action, args, confirmed: false });
    },
  };
}

/**
 * Shows a confirm/cancel prompt before a destructive action.
 *
 * The buttons carry no state beyond their own ids; everything needed to run the action is
 * captured in this closure. That keeps a stale button on an old message from doing anything —
 * the collector is gone, so the click simply expires.
 */
async function confirmThenRun(interaction, { name, action, args }) {
  const window = args.duration ? ` for **${args.duration}**` : ' **permanently**';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tempest_confirm').setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tempest_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: `About to **${name}** \`${args.player}\`${window}.\nReason: ${args.reason || '—'}`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });

  const message = await interaction.fetchReply();
  let click;
  try {
    click = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: 30000,
    });
  } catch {
    return interaction.editReply({ content: 'Timed out — nothing was done.', components: [] });
  }

  if (click.customId === 'tempest_cancel') {
    return click.update({ content: 'Cancelled — nothing was done.', components: [] });
  }
  await click.update({ content: 'Working…', components: [] });
  return finish(interaction, { name, action, args, confirmed: true });
}

/** Runs the action and reports the plugin's answer verbatim. */
async function finish(interaction, { name, action, args, confirmed }) {
  let result;
  try {
    result = await tempest.run(
      interaction.user.id,
      interaction.user.tag,
      action,
      args,
      confirmed
    );
  } catch (e) {
    // The database being up but missing the table reads as a connection failure
    // otherwise, which sends people to check the wrong thing entirely.
    const missing = e.code === 'ER_NO_SUCH_TABLE';
    return interaction.editReply({
      content: missing
        ? 'The Minecraft server accepts the connection, but its command bridge is not '
          + 'turned on — the table these run through does not exist yet. Nothing was done.'
        : `Could not reach the Minecraft server: ${e.message}`,
      components: [],
    });
  }

  const embed = new EmbedBuilder()
    .setColor(result.ok ? COLORS.promote || 0x57f287 : COLORS.demote || 0xed4245)
    .setTitle(result.ok ? `${name} — done` : `${name} — not done`)
    // The plugin's message is already human-readable and already says why it refused.
    .setDescription(result.message || (result.ok ? 'Done.' : 'That did not work.'))
    .setFooter({ text: `${args.player} · ${result.code || ''}`.trim() });

  // Worth surfacing, because these two are the ones people misread as a bug.
  if (result.code === 'NOT_LINKED') {
    embed.setDescription(
      'You have not linked a Minecraft account yet. Join the server, copy the code it shows ' +
        'you, then run `/link code`.'
    );
  } else if (result.code === 'NO_PERMISSION') {
    embed.setDescription(
      'Your linked Minecraft account does not have permission for that. Discord roles do not ' +
        'grant it — the permission comes from your in-game rank.'
    );
  }

  await interaction.editReply({ content: '', embeds: [embed], components: [] });

  if (result.ok) {
    // Counts towards the staff member's own activity, same as an in-game action would.
    try {
      db.bumpMetric(interaction.guildId, interaction.user.id, 'modActions');
    } catch {
      // Scoring is a nice-to-have; never let it turn a successful ban into an error.
    }
  }
  return undefined;
}

module.exports = { build };

const { EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../config');

function err(interaction, message) {
  const embed = new EmbedBuilder()
    .setColor(config.colors.demote)
    .setDescription(`⛔ ${message}`);
  return respond(interaction, embed, true);
}

function ok(interaction, embed, { ephemeral = false } = {}) {
  return respond(interaction, embed, ephemeral);
}

/**
 * One place that knows how to answer an interaction, whatever state it is in.
 *
 * This matters: after deferReply() the correct call is editReply(), NOT
 * reply() (already answered) and NOT followUp() (that posts a second message
 * and, on a deferred interaction, leaves the original "thinking" state
 * dangling). Getting this wrong throws InteractionAlreadyReplied, which
 * surfaces to the user as a useless "something went wrong".
 *
 * Note also that ephemerality is fixed at defer time — editReply cannot
 * change it, so the flag is only meaningful on a fresh reply.
 */
function respond(interaction, embed, ephemeral) {
  const payload = { embeds: [embed] };

  if (interaction.deferred && !interaction.replied) {
    return interaction.editReply(payload).catch((e) => {
      console.error('[respond] editReply failed:', e.message);
    });
  }
  if (interaction.replied) {
    if (ephemeral) payload.flags = MessageFlags.Ephemeral;
    return interaction.followUp(payload).catch((e) => {
      console.error('[respond] followUp failed:', e.message);
    });
  }
  if (ephemeral) payload.flags = MessageFlags.Ephemeral;
  return interaction.reply(payload).catch((e) => {
    console.error('[respond] reply failed:', e.message);
  });
}

/**
 * Short ephemeral confirmation for the staff member who ran the command.
 *
 * Command replies are ALWAYS ephemeral for anything involving a reason:
 * staff run /promote and /demote wherever they happen to be standing, and a
 * visible reply would drop "Reason: repeatedly rude in tickets" into a public
 * channel. The full record goes to the staff log, the sanitised version goes
 * to the movements channel, and the runner just gets a receipt.
 */
function receipt(interaction, title, { announced = false } = {}) {
  const bits = [];
  if (config.channels.staffLog) bits.push(`logged in <#${config.channels.staffLog}>`);
  if (announced && config.announcements?.channelId) {
    bits.push(`announced in <#${config.announcements.channelId}>`);
  }
  // With the private log switched off the reason still exists — it just lives
  // in the database and their DM. Say so, or it looks like it went nowhere.
  if (!config.channels.staffLog) bits.push('reason saved to their record + DM');

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(config.colors.promote)
        .setDescription(`✅ ${title}${bits.length ? `\n\n${D_ITALIC(bits.join(' · '))}` : ''}`),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

const D_ITALIC = (s) => `_${s}_`;

/**
 * Full internal record. No-ops when channels.staffLog is null, which is the
 * default now — the reason still lives in the audit table and their DM.
 */
async function logAction(guild, embed) {
  const id = config.channels.staffLog;
  if (!id) return;
  try {
    const ch = await guild.channels.fetch(id);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error('[log] could not post to staff log channel:', e.message);
  }
}

/**
 * Public staff-movements post. Deliberately separate from logAction():
 * that one is an internal audit trail, this is member-facing. Nothing
 * sensitive should ever be passed in here.
 */
async function announce(guild, payload) {
  const a = config.announcements;
  if (!a?.channelId) return;
  try {
    const ch = await guild.channels.fetch(a.channelId);
    if (!ch?.isTextBased()) return;
    await ch.send(payload);
  } catch (e) {
    console.error('[announce] could not post to announcements channel:', e.message);
  }
}

async function postToReviews(guild, payload) {
  const id = config.channels.reviews;
  if (!id) return null;
  try {
    const ch = await guild.channels.fetch(id);
    if (ch?.isTextBased()) return await ch.send(payload);
  } catch (e) {
    console.error('[log] could not post to reviews channel:', e.message);
  }
  return null;
}

/** Try to DM someone; never throw if their DMs are closed. */
async function tryDM(user, payload) {
  try {
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

module.exports = { err, ok, respond, receipt, logAction, announce, postToReviews, tryDM };

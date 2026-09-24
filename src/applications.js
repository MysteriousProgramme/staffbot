'use strict';

// Applications: a panel with a button, a form, and a staff decision.
//
// Close cousin of the ticket system, deliberately not built on it. A ticket is a
// conversation that needs a room; an application is a form that needs an answer, and
// giving every applicant a private channel would bury the staff team in rooms nobody
// talks in. The two share no state, so changing one cannot break the other.
//
// The panel differs from the ticket panel in one way that shapes everything here: it
// shows OPEN or CLOSED, so it is not disposable. Every posted panel is remembered and
// edited when the state changes, because a stale panel in a forgotten channel saying
// OPEN is worse than no panel at all.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, AttachmentBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const db = require('./db');
const R = require('./ranks');

const ID = {
  start: 'app_start',
  modal: 'app_modal',
  accept: 'app_accept',
  deny: 'app_deny',
};

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

function settings() {
  return config.applications ?? {};
}

function enabled() {
  return settings().enabled === true && (settings().kinds ?? []).length > 0;
}

function kinds() {
  return settings().kinds ?? [];
}

function kindByKey(key) {
  return kinds().find((k) => k.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Turns `:name:` into the server's own `<:name:id>`.
 *
 * Config names the emoji rather than carrying its id, because an id is opaque, and
 * because re-uploading an emoji changes it — which would leave the panel rendering
 * raw `<:check:123>` text with nothing to say why.
 *
 * A name the server does not have is left exactly as it was written. That keeps the
 * greedy-looking pattern safe: something like a timestamp is not an emoji, does not
 * match anything, and comes out unchanged.
 */
function withEmoji(guild, text) {
  if (!text || !guild) return text ?? '';
  return String(text).replace(/:([a-z0-9_]{2,32}):/gi, (whole, name) => {
    const emoji = guild.emojis.cache.find((e) => e.name === name);
    return emoji ? emoji.toString() : whole;
  });
}


/** Where a kind's own image lives. Kept out of src/ so it is obvious what it is for. */
const ASSETS = path.join(__dirname, '..', 'assets');

/**
 * The file behind `thumbnailFile`, or null when there is not one.
 *
 * Checked on every draw rather than cached at boot, so dropping the png in and
 * running /application open is enough — no restart to make an image appear.
 *
 * The name is taken as a basename on purpose. This value comes from config rather
 * than from a user, but a path that can climb out of the folder is the kind of thing
 * that stops being harmless the moment somebody makes config editable elsewhere.
 */
function assetFile(name) {
  if (!name) return null;
  const file = path.join(ASSETS, path.basename(String(name)));
  return fs.existsSync(file) ? file : null;
}

/**
 * The panel message for a kind, in its current open/closed state.
 *
 * Built fresh every time rather than stored, so editing the wording in config and
 * running /application open is enough to update every panel that exists.
 */
function buildPanel(guild, kind) {
  const open = db.applicationsOpen(guild.id, kind.key);
  const mark = open ? kind.openEmoji : kind.closedEmoji;

  const embed = new EmbedBuilder()
    .setColor(kind.color ?? 0x5865f2)
    // Custom emoji do not render in a title, only in a description, so the title
    // is left plain rather than quietly dropping whatever was put in it.
    .setTitle(kind.name)
    .setDescription(
      withEmoji(guild, `${kind.description ?? ''}\n\n**Status:** `
        + `${open ? 'OPEN' : 'CLOSED'}${mark ? ` ${mark}` : ''}`).trim()
    );

  // attachment:// resolves only against a file on the SAME message, so the file has
  // to ride along on every edit too — see `files` below. Sending the embed without
  // it would leave a broken image rather than no image.
  const files = [];
  const asset = assetFile(kind.thumbnailFile);
  if (asset) {
    const name = path.basename(asset);
    files.push(new AttachmentBuilder(asset, { name }));
    embed.setThumbnail(`attachment://${name}`);
  } else if (kind.thumbnailUrl && /^https?:\/\//.test(kind.thumbnailUrl)) {
    // Falls back rather than failing: a missing file should cost you a thumbnail,
    // not the panel.
    embed.setThumbnail(kind.thumbnailUrl);
  }

  const button = new ButtonBuilder()
    .setCustomId(`${ID.start}:${kind.key}`)
    .setLabel(kind.buttonLabel || 'Start Application!')
    .setStyle(ButtonStyle.Success)
    // Disabled rather than removed: a button that is there and greyed out says
    // "not now", an absent one says "you are in the wrong channel".
    .setDisabled(!open);

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)],
    // Re-sent on every edit. Leaving it out would drop the attachment the embed
    // points at, and the thumbnail would break the first time anyone opened or
    // closed applications.
    files,
  };
}

/**
 * Rewrites every panel for a kind after its state changes.
 *
 * A panel whose message has been deleted is forgotten rather than retried — otherwise
 * every open and close would spend its time failing against messages that will never
 * come back.
 */
async function refreshPanels(client, guild, kind) {
  const rows = db.listAppPanels(guild.id, kind.key);
  let edited = 0;
  let forgotten = 0;

  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const channel = await client.channels.fetch(row.channel_id);
      // eslint-disable-next-line no-await-in-loop
      const message = await channel.messages.fetch(row.message_id);
      // eslint-disable-next-line no-await-in-loop
      await message.edit(buildPanel(guild, kind));
      edited++;
    } catch {
      db.forgetAppPanel(row.message_id);
      forgotten++;
    }
  }
  return { edited, forgotten };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** Why this person cannot apply right now, or null if they can. */
function blockedReason(guildId, kind, userId) {
  if (!db.applicationsOpen(guildId, kind.key)) {
    return `**${kind.name}** are closed right now.`;
  }
  const max = Number(kind.maxPending ?? 1);
  if (max > 0 && db.pendingApplicationCount(guildId, kind.key, userId) >= max) {
    return max === 1
      ? 'You already have an application waiting on a decision.'
      : `You already have ${max} applications waiting on a decision.`;
  }
  return null;
}

async function handleStart(interaction) {
  const kind = kindByKey(interaction.customId.split(':')[1]);
  if (!kind) return interaction.reply(ephemeral('That application no longer exists.'));

  // Checked before the form, so nobody fills one in only to be turned away.
  const blocked = blockedReason(interaction.guildId, kind, interaction.user.id);
  if (blocked) return interaction.reply(ephemeral(blocked));

  const questions = (kind.questions ?? []).slice(0, 5);
  if (questions.length === 0) {
    return interaction.reply(ephemeral('This application has no questions set up yet.'));
  }

  const modal = new ModalBuilder()
    .setCustomId(`${ID.modal}:${kind.key}`)
    // Discord truncates past 45 and the panel name is usually longer.
    .setTitle(kind.name.slice(0, 45));

  for (const q of questions) {
    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setLabel(String(q.label).slice(0, 45))
      .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(q.required !== false);
    if (q.maxLength) input.setMaxLength(Number(q.maxLength));
    if (q.placeholder) input.setPlaceholder(String(q.placeholder).slice(0, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return interaction.showModal(modal);
}

async function handleSubmit(interaction) {
  const kind = kindByKey(interaction.customId.split(':')[1]);
  if (!kind) return interaction.reply(ephemeral('That application no longer exists.'));

  // Re-checked: the form sat open while they typed, and applications may have closed
  // or they may have submitted another one in a second tab.
  const blocked = blockedReason(interaction.guildId, kind, interaction.user.id);
  if (blocked) return interaction.reply(ephemeral(blocked));

  const answers = (kind.questions ?? []).slice(0, 5).map((q) => ({
    label: q.label,
    value: interaction.fields.getTextInputValue(q.id) || '—',
  }));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const id = db.addApplication(
    interaction.guildId, kind.key, interaction.user.id, interaction.user.tag, answers
  );

  const posted = await postForReview(interaction, kind, id, answers);
  if (!posted) {
    return interaction.editReply(
      'Your application was saved, but it could not be posted for review — '
      + `tell a staff member to check \`pendingChannelId\` for **${kind.key}**.`
    );
  }

  return interaction.editReply(
    `Your application for **${kind.name}** has been submitted. `
    + "You will be told here and by DM once it has been looked at."
  );
}

/** The review card, with the buttons that decide it. */
async function postForReview(interaction, kind, id, answers) {
  const channelId = kind.pendingChannelId;
  if (!channelId) return false;

  const embed = new EmbedBuilder()
    .setColor(kind.color ?? 0x5865f2)
    .setTitle(`${kind.name} — #${id}`)
    .setAuthor({
      name: interaction.user.tag,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setDescription(`From <@${interaction.user.id}>`)
    .setFooter({ text: `Application #${id} · user ${interaction.user.id}` })
    .setTimestamp();

  for (const a of answers) {
    // An embed field dies at 1024; a paragraph answer can legitimately be longer.
    embed.addFields({ name: String(a.label).slice(0, 256), value: a.value.slice(0, 1024) });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID.accept}:${id}:${kind.key}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${ID.deny}:${id}:${kind.key}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
  );

  try {
    const channel = await interaction.client.channels.fetch(channelId);
    const message = await channel.send({ embeds: [embed], components: [row] });
    db.setApplicationReviewMessage(id, message.id);
    return true;
  } catch (e) {
    console.error(`[applications] could not post #${id} for review: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

async function handleDecision(interaction, accepted) {
  const [, rawId, kindKey] = interaction.customId.split(':');
  const kind = kindByKey(kindKey);
  if (!kind) return interaction.reply(ephemeral('That application no longer exists.'));

  const needed = kind.reviewRank ?? config.permissions.review;
  if (!R.meetsRequirement(interaction.member, needed)) {
    const rank = R.rankByKey(needed)?.name ?? needed;
    return interaction.reply(ephemeral(`Only ${rank} and above can decide applications.`));
  }

  const application = db.getApplication(Number(rawId));
  if (!application) return interaction.reply(ephemeral('That application is no longer on file.'));

  await interaction.deferUpdate();

  // Conditional on still being pending, so two reviewers clicking together cannot
  // both decide it — and the loser is told who got there first rather than silently
  // overwriting them.
  if (!db.decideApplication(application.id, accepted ? 'accepted' : 'denied', interaction.user.id)) {
    const fresh = db.getApplication(application.id);
    return interaction.followUp(ephemeral(
      `Already ${fresh?.status ?? 'decided'}${fresh?.decided_by ? ` by <@${fresh.decided_by}>` : ''}.`
    ));
  }

  const notes = [];
  if (accepted && kind.acceptedRoleId) {
    notes.push(await grantRole(interaction, kind, application.user_id));
  }
  notes.push(await tellApplicant(interaction, kind, application, accepted));
  await moveCard(interaction, kind, application, accepted);

  const problems = notes.filter(Boolean);
  if (problems.length) {
    return interaction.followUp(ephemeral(problems.join('\n')));
  }
  return undefined;
}

/** Returns a problem to report, or null when it worked. */
async function grantRole(interaction, kind, userId) {
  try {
    const member = await interaction.guild.members.fetch(userId);
    await member.roles.add(kind.acceptedRoleId, `Application accepted by ${interaction.user.tag}`);
    return null;
  } catch (e) {
    // The decision stands either way — it is recorded, and a role that failed to
    // apply is fixable by hand, whereas a decision that half-happened is not.
    return `Accepted, but the role could not be given: ${e.message}`;
  }
}

async function tellApplicant(interaction, kind, application, accepted) {
  try {
    const user = await interaction.client.users.fetch(application.user_id);
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(accepted ? config.colors.promote : config.colors.demote)
          .setTitle(accepted ? 'Application accepted' : 'Application not accepted')
          .setDescription(
            accepted
              ? `Your application for **${kind.name}** was accepted.`
              : `Your application for **${kind.name}** was not accepted this time.`
          ),
      ],
    });
    return null;
  } catch {
    // Closed DMs are common and not a failure of the decision.
    return `Decided, but <@${application.user_id}> has DMs closed so they were not told.`;
  }
}

/**
 * Moves the decided card out of pending and into accepted or denied.
 *
 * Posted and then deleted rather than edited in place, because the point of separate
 * channels is that the pending one only ever holds things still waiting. A decided
 * card left behind means somebody reads it as work to do.
 */
async function moveCard(interaction, kind, application, accepted) {
  const target = accepted ? kind.acceptedChannelId : kind.deniedChannelId;
  const embed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(accepted ? config.colors.promote : config.colors.demote)
    .addFields({
      name: accepted ? 'Accepted by' : 'Denied by',
      value: `<@${interaction.user.id}>`,
    });

  if (target) {
    try {
      const channel = await interaction.client.channels.fetch(target);
      await channel.send({ embeds: [embed] });
      await interaction.message.delete();
      return;
    } catch (e) {
      console.error(`[applications] could not move #${application.id}: ${e.message}`);
    }
  }

  // No destination, or it failed: leave the card where it is with its buttons gone,
  // so the decision is still visible and cannot be clicked twice.
  await interaction.message.edit({ embeds: [embed], components: [] }).catch(() => {});
}

// ---------------------------------------------------------------------------

/** Ignores anything that is not ours, so it can sit alongside the ticket router. */
async function handle(interaction) {
  if (!enabled()) return false;

  const id = interaction.customId ?? '';
  if (!id.startsWith('app_')) return false;

  try {
    if (interaction.isButton() && id.startsWith(ID.start)) {
      await handleStart(interaction);
    } else if (interaction.isModalSubmit() && id.startsWith(ID.modal)) {
      await handleSubmit(interaction);
    } else if (interaction.isButton() && id.startsWith(ID.accept)) {
      await handleDecision(interaction, true);
    } else if (interaction.isButton() && id.startsWith(ID.deny)) {
      await handleDecision(interaction, false);
    } else {
      return false;
    }
  } catch (e) {
    console.error(`[applications] ${id}: ${e.message}`);
    const reply = ephemeral('Something went wrong with that. A staff member should check the logs.');
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
  return true;
}

module.exports = {
  enabled, kinds, kindByKey, buildPanel, refreshPanels, blockedReason, handle, ID,
};

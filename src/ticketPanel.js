const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

const config = require('../config');
const db = require('./db');
const tickets = require('./tickets');

/**
 * Everything the ticket system does through buttons, dropdowns and modals.
 *
 * Every customId here is a fixed string — never an encoded ticket id. State is
 * looked up from the tickets table by channel, which means the buttons on a
 * ticket opened last month still work after a restart, a redeploy, or a
 * database restored from backup. Nothing is held in memory.
 */

const T = () => config.tickets ?? {};
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// ---------------------------------------------------------------
// The panel
// ---------------------------------------------------------------

function buildPanel() {
  const types = (T().types ?? []).slice(0, 25); // Discord's hard limit on menu options
  if (!types.length) throw new Error('config.tickets.types is empty — there is nothing to offer.');

  const embed = new EmbedBuilder()
    .setColor(config.colors.ticket)
    .setTitle(T().panel?.title ?? 'Support')
    .setDescription(T().panel?.description ?? 'Choose a category below to open a ticket.')
    .addFields(
      types.map((t) => ({
        name: `${t.emoji ?? '🎫'} ${t.label}`,
        value: t.description ?? '​',
        inline: false,
      }))
    );

  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket:open')
    .setPlaceholder(T().panel?.placeholder ?? 'Choose a ticket type…')
    .addOptions(
      types.map((t) => {
        const opt = {
          label: t.label.slice(0, 100),
          value: t.key,
          description: (t.description ?? '').slice(0, 100) || undefined,
        };
        if (t.emoji) opt.emoji = t.emoji;
        return opt;
      })
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

// ---------------------------------------------------------------
// Opening
// ---------------------------------------------------------------

function modalFor(type) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket:modal:${type.key}`)
    .setTitle(type.label.slice(0, 45));

  for (const q of (type.questions ?? []).slice(0, 5)) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(q.id)
          .setLabel(q.label.slice(0, 45))
          .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(q.required !== false)
          .setMaxLength(Math.min(q.max ?? 1000, 4000))
      )
    );
  }

  return modal;
}

/** Shared by the dropdown and by /ticket open. */
async function openFor(interaction, type, answers) {
  const blocked = tickets.openBlockedReason(interaction.guild, interaction.user.id);
  if (blocked) return interaction.editReply({ content: blocked });

  const { channel, ticket } = await tickets.createTicket({
    guild: interaction.guild,
    opener: interaction.user,
    type,
    answers,
  });

  db.addAudit(interaction.guild.id, interaction.user.id, interaction.user.id, 'ticket_open', `#${tickets.pad(ticket.number)} ${type.key}`);

  return interaction.editReply({
    content: `Your ticket is open: <#${channel.id}>`,
  });
}

async function handleSelect(interaction) {
  const type = tickets.typeByKey(interaction.values[0]);

  // Put the dropdown back to its placeholder. Without this it keeps showing
  // whatever the last person picked, to everybody.
  interaction.message.edit({ components: buildPanel().components }).catch(() => {});

  if (!type) return interaction.reply(ephemeral('That ticket type no longer exists.'));

  // Checked before the form, so nobody fills one in only to be turned away.
  const blocked = tickets.openBlockedReason(interaction.guild, interaction.user.id);
  if (blocked) return interaction.reply(ephemeral(blocked));

  if (type.questions?.length) {
    // showModal must be the FIRST response to an interaction — deferring
    // first makes Discord reject it.
    return interaction.showModal(modalFor(type));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return openFor(interaction, type, {});
}

async function handleModal(interaction) {
  const type = tickets.typeByKey(interaction.customId.split(':')[2]);
  if (!type) return interaction.reply(ephemeral('That ticket type no longer exists.'));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const answers = {};
  // Same slice modalFor uses. A sixth question was never rendered, so asking
  // the submission for it throws instead of just being blank.
  for (const q of (type.questions ?? []).slice(0, 5)) {
    const v = interaction.fields.getTextInputValue(q.id);
    if (v?.trim()) answers[q.id] = v.trim();
  }

  return openFor(interaction, type, answers);
}

// ---------------------------------------------------------------
// In-ticket buttons
// ---------------------------------------------------------------

const confirmRow = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:close:confirm')
      .setLabel('Close it')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ticket:close:cancel')
      .setLabel('Keep it open')
      .setStyle(ButtonStyle.Secondary)
  );

async function handleButton(interaction) {
  const [, action, sub] = interaction.customId.split(':');

  const ticket = db.getTicket(interaction.channelId);
  if (!ticket || ticket.state !== 'open') {
    return interaction.reply(ephemeral('This is not an open ticket.'));
  }

  if (!tickets.isTicketStaff(interaction.member)) {
    return interaction.reply(ephemeral('Only staff can use these buttons.'));
  }

  if (action === 'claim') {
    if (ticket.claimed_by) {
      return interaction.reply(ephemeral(`<@${ticket.claimed_by}> already has this one.`));
    }
    await interaction.deferUpdate();
    return tickets.claim(interaction.channel, ticket, interaction.member);
  }

  if (action === 'unclaim') {
    if (!ticket.claimed_by) return interaction.reply(ephemeral('Nobody has claimed this.'));
    await interaction.deferUpdate();
    return tickets.unclaim(interaction.channel, ticket);
  }

  if (action === 'close') {
    if (sub === 'cancel') {
      return interaction.update({ content: 'Left open.', components: [] });
    }

    if (sub === 'confirm') {
      await interaction.update({ content: 'Closing…', components: [] });
      const { credited } = await tickets.close({
        channel: interaction.channel,
        ticket,
        closer: interaction.user,
      });
      return interaction.editReply({
        content: `Closed. Credited ${credited.length ? credited.map((id) => `<@${id}>`).join(', ') : 'nobody'}.`,
      });
    }

    return interaction.reply({
      content: 'Close this ticket? The transcript goes to the log channel first.',
      components: [confirmRow()],
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply(ephemeral('That button does nothing any more.'));
}

// ---------------------------------------------------------------

/** Returns true if this interaction belonged to the ticket system. */
async function handle(interaction) {
  const id = interaction.customId ?? '';
  if (!id.startsWith('ticket:')) return false;

  if (!interaction.inGuild()) {
    await interaction.reply(ephemeral('Tickets only work inside the server.'));
    return true;
  }

  try {
    if (interaction.isStringSelectMenu()) await handleSelect(interaction);
    else if (interaction.isModalSubmit()) await handleModal(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
    else return false;
  } catch (error) {
    console.error('[tickets] interaction failed:', error);
    const detail = String(error?.message ?? error).slice(0, 300);
    const payload = ephemeral(`That didn't work:\n\`\`\`\n${detail}\n\`\`\``);
    try {
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: payload.content });
      else if (interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch (e) {
      console.error('[tickets] could not report that back:', e.message);
    }
  }

  return true;
}

module.exports = { handle, buildPanel, modalFor, openFor };

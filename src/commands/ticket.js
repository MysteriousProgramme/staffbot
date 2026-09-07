const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const tickets = require('../tickets');
const { err, ok, logAction } = require('../util');

/**
 * Everything the buttons cannot do.
 *
 * The Claim and Close buttons cover the common path; this is for the rest —
 * handing a ticket over, pulling in a witness, escalating, and managing who
 * is allowed to open one at all.
 */

const T = () => config.tickets ?? {};

/** Most of these only mean anything standing inside an open ticket. */
function requireTicket(interaction) {
  const ticket = db.getTicket(interaction.channelId);
  if (!ticket || ticket.source !== 'native') {
    return { error: 'Run this inside a ticket channel.' };
  }
  if (ticket.state !== 'open') return { error: 'This ticket is already closed.' };
  if (!tickets.isTicketStaff(interaction.member)) {
    return { error: 'Only staff can manage tickets.' };
  }
  return { ticket };
}

const note = (interaction, text) =>
  interaction.reply({
    embeds: [new EmbedBuilder().setColor(config.colors.promote).setDescription(`✅ ${text}`)],
    flags: MessageFlags.Ephemeral,
  });

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Manage a ticket')
    .addSubcommand((s) => s.setName('claim').setDescription('Take ownership of this ticket'))
    .addSubcommand((s) => s.setName('unclaim').setDescription('Put this ticket back up for grabs'))
    .addSubcommand((s) =>
      s
        .setName('transfer')
        .setDescription('Hand this ticket to another staff member')
        .addUserOption((o) => o.setName('user').setDescription('Who is taking it over').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('escalate')
        .setDescription('Pull in the rank above you')
        .addStringOption((o) => o.setName('reason').setDescription('Why it needs escalating').setMaxLength(500))
    )
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Give someone access to this ticket')
        .addUserOption((o) => o.setName('user').setDescription('Who to add').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Take away someone access to this ticket')
        .addUserOption((o) => o.setName('user').setDescription('Who to remove').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('priority')
        .setDescription('Set how urgent this ticket is')
        .addStringOption((o) =>
          o
            .setName('level')
            .setDescription('How urgent')
            .setRequired(true)
            .addChoices(
              ...Object.entries(tickets.PRIORITIES).map(([key, p]) => ({
                name: `${p.emoji} ${p.label}`,
                value: key,
              }))
            )
        )
    )
    .addSubcommand((s) =>
      s
        .setName('rename')
        .setDescription('Rename this ticket channel')
        .addStringOption((o) =>
          o.setName('name').setDescription('New name — the ticket number is kept').setRequired(true).setMaxLength(60)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('close')
        .setDescription('Close this ticket')
        .addStringOption((o) => o.setName('reason').setDescription('How it was resolved').setMaxLength(500))
    )
    .addSubcommand((s) =>
      s
        .setName('blacklist')
        .setDescription('Block someone from opening tickets')
        .addUserOption((o) => o.setName('user').setDescription('Who to block').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why — they will be shown this').setMaxLength(300))
    )
    .addSubcommand((s) =>
      s
        .setName('unblacklist')
        .setDescription('Let someone open tickets again')
        .addUserOption((o) => o.setName('user').setDescription('Who to unblock').setRequired(true))
    )
    .addSubcommand((s) => s.setName('blacklisted').setDescription('List everyone blocked from opening tickets')),

  async execute(interaction) {
    if (!T().enabled) return err(interaction, 'The ticket system is turned off in config.js.');

    const sub = interaction.options.getSubcommand();

    // ---- blacklist management: not tied to a channel ----
    if (sub === 'blacklist' || sub === 'unblacklist' || sub === 'blacklisted') {
      return blacklistCommands(interaction, sub);
    }

    const { ticket, error } = requireTicket(interaction);
    if (error) return err(interaction, error);

    switch (sub) {
      case 'claim': {
        if (ticket.claimed_by) {
          return err(interaction, `<@${ticket.claimed_by}> already has this one. Use \`/ticket transfer\`.`);
        }
        await tickets.claim(interaction.channel, ticket, interaction.member);
        return note(interaction, 'Claimed.');
      }

      case 'unclaim': {
        if (!ticket.claimed_by) return err(interaction, 'Nobody has claimed this.');
        await tickets.unclaim(interaction.channel, ticket);
        return note(interaction, 'Unclaimed.');
      }

      case 'transfer': {
        const user = interaction.options.getUser('user');
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return err(interaction, 'That user is not in this server.');
        if (!tickets.isTicketStaff(target)) return err(interaction, `**${user.username}** is not staff.`);
        if (target.id === interaction.user.id) return err(interaction, 'It is already yours.');

        await tickets.transfer(interaction.channel, ticket, target, interaction.user);
        return note(interaction, `Handed to <@${target.id}>.`);
      }

      case 'escalate': {
        const reason = interaction.options.getString('reason');
        const rank = await tickets.escalate(interaction.channel, ticket, interaction.member, reason);
        return note(interaction, `Escalated to **${rank?.name ?? 'senior staff'}**.`);
      }

      case 'add': {
        const user = interaction.options.getUser('user');
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return err(interaction, 'That user is not in this server.');
        await tickets.addUser(interaction.channel, target);
        return note(interaction, `<@${target.id}> can now see this ticket.`);
      }

      case 'remove': {
        const user = interaction.options.getUser('user');
        if (user.id === ticket.opener_id) {
          return err(interaction, 'That is the person who opened it. Close the ticket instead.');
        }
        const target = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!target) return err(interaction, 'That user is not in this server.');
        await tickets.removeUser(interaction.channel, target);
        return note(interaction, `<@${target.id}> was removed.`);
      }

      case 'priority': {
        const level = interaction.options.getString('level');
        const renamed = await tickets.setPriority(interaction.channel, ticket, level);
        return note(
          interaction,
          `Priority set to **${tickets.PRIORITIES[level].label}**.` +
            (renamed
              ? ''
              : '\n_Discord would not let me rename the channel right now — it limits renames to about twice per 10 minutes. The priority itself is saved._')
        );
      }

      case 'rename': {
        const name = await tickets.rename(interaction.channel, ticket, interaction.options.getString('name'));
        return note(interaction, `Renamed to **#${name}**.`);
      }

      case 'close': {
        await interaction.reply({ content: 'Closing…', flags: MessageFlags.Ephemeral });
        const { credited } = await tickets.close({
          channel: interaction.channel,
          ticket,
          closer: interaction.user,
          reason: interaction.options.getString('reason'),
        });
        return interaction.editReply({
          content: `Closed. Credited ${
            credited.length ? credited.map((id) => `<@${id}>`).join(', ') : 'nobody'
          }.`,
        });
      }

      default:
        return err(interaction, 'Unknown subcommand.');
    }
  },
};

// ---------------------------------------------------------------

async function blacklistCommands(interaction, sub) {
  if (!R.meetsRequirement(interaction.member, config.permissions.manageStaff)) {
    return err(
      interaction,
      `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to manage the ticket blacklist.`
    );
  }

  const guildId = interaction.guild.id;

  if (sub === 'blacklisted') {
    const rows = db.listTicketBlacklist(guildId);
    const embed = new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setTitle('Ticket blacklist')
      .setDescription(
        rows.length
          ? rows
              .slice(0, 25)
              .map(
                (r) =>
                  `<@${r.user_id}> — ${r.reason ?? '_no reason given_'}\n` +
                  `-# blocked by <@${r.author_id}> <t:${Math.floor(r.created_at / 1000)}:R>`
              )
              .join('\n\n')
          : 'Nobody is blocked from opening tickets.'
      );
    if (rows.length > 25) embed.setFooter({ text: `…and ${rows.length - 25} more` });
    return ok(interaction, embed, { ephemeral: true });
  }

  const user = interaction.options.getUser('user');
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);

  if (sub === 'blacklist') {
    if (db.isTicketBlacklisted(guildId, user.id)) {
      return err(interaction, `**${user.username}** is already blocked.`);
    }
    const reason = interaction.options.getString('reason');
    db.addTicketBlacklist(guildId, user.id, reason, interaction.user.id);
    db.addAudit(guildId, interaction.user.id, user.id, 'ticket_blacklist', reason ?? null);
    const warning = await tickets.applyBlacklistRole(member, true);

    await logAction(
      interaction.guild,
      new EmbedBuilder()
        .setColor(config.colors.demote)
        .setTitle('Ticket blacklist added')
        .setDescription(`<@${user.id}> can no longer open tickets.`)
        .addFields(
          { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Reason', value: reason ?? '_none given_' }
        )
        .setTimestamp()
    );

    return note(
      interaction,
      `**${user.username}** can no longer open tickets.` + (warning ? `\n⚠️ ${warning}` : '')
    );
  }

  // unblacklist
  if (!db.removeTicketBlacklist(guildId, user.id)) {
    return err(interaction, `**${user.username}** was not blocked.`);
  }
  db.addAudit(guildId, interaction.user.id, user.id, 'ticket_unblacklist', null);
  const warning = await tickets.applyBlacklistRole(member, false);

  await logAction(
    interaction.guild,
    new EmbedBuilder()
      .setColor(config.colors.promote)
      .setTitle('Ticket blacklist lifted')
      .setDescription(`<@${user.id}> can open tickets again.`)
      .addFields({ name: 'By', value: `<@${interaction.user.id}>`, inline: true })
      .setTimestamp()
  );

  return note(interaction, `**${user.username}** can open tickets again.` + (warning ? `\n⚠️ ${warning}` : ''));
}

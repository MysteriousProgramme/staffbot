const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, ok, tryDM } = require('../util');

const DAY = 86400000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loa')
    .setDescription('Leave of absence — pause the clock on someone without penalising them')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Put a staff member on leave')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('days').setDescription('How many days').setRequired(true).setMinValue(1).setMaxValue(120)
        )
        .addStringOption((o) => o.setName('reason').setDescription('Exams, holiday, whatever'))
    )
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('Bring someone back early')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    )
    .addSubcommand((s) => s.setName('list').setDescription('Everyone currently on leave')),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.manageStaff)) {
      return err(
        interaction,
        `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to manage leave.`
      );
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return start(interaction);
    if (sub === 'end') return end(interaction);
    if (sub === 'list') return list(interaction);
  },
};

async function start(interaction) {
  const user = interaction.options.getUser('user');
  const days = interaction.options.getInteger('days');
  const reason = interaction.options.getString('reason') ?? 'No reason given';

  const row = db.getStaff(interaction.guildId, user.id);
  if (!row) return err(interaction, `**${user.username}** isn't tracked as staff.`);
  if (db.activeLoa(interaction.guildId, user.id)) {
    return err(interaction, `**${user.username}** is already on leave. Use \`/loa end\` first.`);
  }

  const loa = db.startLoa(interaction.guildId, user.id, days, reason, interaction.user.id);

  // If they're mid-trial, push the deadline out by the same number of days.
  // That's the whole point: they get their full run of active days, rather
  // than a fortnight of which half was spent revising.
  let extended = null;
  if (row.trial_ends_at && ['active', 'midpoint_posted'].includes(row.trial_state)) {
    extended = row.trial_ends_at + days * DAY;
    db.setTrialEnd(interaction.guildId, user.id, extended);
  }

  db.addAudit(interaction.guildId, interaction.user.id, user.id, 'loa_start', `${days}d: ${reason}`);

  await tryDM(user, {
    embeds: [
      new EmbedBuilder()
        .setColor(config.colors.neutral)
        .setTitle(`You're on leave in ${interaction.guild.name}`)
        .setDescription(
          `**${days} days**, back <t:${Math.floor(loa.end_at / 1000)}:D>.\n\n` +
            `Nothing counts against you while you're away — you won't show up as inactive` +
            (extended ? ', and your trial deadline has moved back by the same amount' : '') +
            `. Enjoy the break.`
        ),
    ],
  });

  return ok(
    interaction,
    new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setAuthor({ name: `${user.username} is on leave`, iconURL: user.displayAvatarURL() })
      .setDescription(
        `**${days} days** — back <t:${Math.floor(loa.end_at / 1000)}:R>.\n${reason}` +
          (extended
            ? `\n\n_Trial deadline moved to <t:${Math.floor(extended / 1000)}:D>._`
            : '')
      ),
    { ephemeral: true }
  );
}

async function end(interaction) {
  const user = interaction.options.getUser('user');
  const loa = db.activeLoa(interaction.guildId, user.id);
  if (!loa) return err(interaction, `**${user.username}** isn't on leave.`);

  db.endLoa(loa.id);
  db.addAudit(interaction.guildId, interaction.user.id, user.id, 'loa_end', 'ended early');

  return ok(
    interaction,
    new EmbedBuilder()
      .setColor(config.colors.promote)
      .setDescription(
        `<@${user.id}> is back off leave.\n\n` +
          `_Their trial deadline was already extended when the leave started and has not been pulled back — they keep the extra days._`
      ),
    { ephemeral: true }
  );
}

async function list(interaction) {
  const rows = db.listActiveLoa(interaction.guildId);
  if (!rows.length) {
    return ok(
      interaction,
      new EmbedBuilder().setColor(config.colors.neutral).setDescription('Nobody is on leave.'),
      { ephemeral: true }
    );
  }
  return ok(
    interaction,
    new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setTitle(`${rows.length} on leave`)
      .setDescription(
        rows
          .map((r) => `<@${r.user_id}> — back <t:${Math.floor(r.end_at / 1000)}:R>${r.reason ? ` · ${r.reason}` : ''}`)
          .join('\n')
      ),
    { ephemeral: true }
  );
}

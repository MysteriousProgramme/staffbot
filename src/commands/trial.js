const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, ok, receipt, logAction, announce, postToReviews, tryDM } = require('../util');
const { buildReviewCard } = require('../reviewCard');
const { buildMovement } = require('../movement');

// The `note:` option replaces the default `-#` subtext under the public
// movement post. Naming the default in the description means the person
// running the command can see what they are overriding.
const noteDesc = (kind) => {
  const d = config.announcements?.defaultNotes?.[kind];
  const base = 'Public subtext under the movement post';
  return (d ? `${base}. Default: "${d}"` : `${base} (no default set)`).slice(0, 100);
};


const DAY = 86400000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trial')
    .setDescription('Manage trial staff')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Hire someone as trial staff and start tracking them')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addIntegerOption((o) =>
          o
            .setName('days')
            .setDescription(`Trial length (default ${config.trial.defaultDays})`)
            .setMinValue(1)
            .setMaxValue(120)
        )
        .addStringOption((o) =>
          o
            .setName('note')
            .setDescription(noteDesc('hire'))
            .setRequired(false)
            .setMaxLength(150)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('extend')
        .setDescription('Give a trial member more time')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('days').setDescription('Extra days').setRequired(true).setMinValue(1).setMaxValue(60)
        )
        .addStringOption((o) => o.setName('reason').setDescription('Why'))
    )
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('End a trial now and post the review card')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show all trials in progress')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const actor = interaction.member;

    if (sub !== 'list' && !R.meetsRequirement(actor, config.permissions.manageStaff)) {
      return err(interaction, `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to manage trials.`);
    }
    if (sub === 'list' && !R.meetsRequirement(actor, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }

    if (sub === 'start') return start(interaction, actor);
    if (sub === 'extend') return extend(interaction, actor);
    if (sub === 'end') return end(interaction, actor);
    if (sub === 'list') return list(interaction);
  },
};

async function start(interaction, actor) {
  const user = interaction.options.getUser('user');
  const days = interaction.options.getInteger('days') ?? config.trial.defaultDays;

  const target = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!target) return err(interaction, 'That user is not in this server.');
  if (target.user.bot) return err(interaction, 'Bots do not get ranks.');

  if (R.memberRankIndex(target) >= 0) {
    return err(interaction, `**${user.username}** already holds a staff rank.`);
  }

  const blocked = R.checkActionAllowed(actor, target, 0);
  if (blocked) return err(interaction, blocked);

  try {
    await R.applyRank(target, 0, `Trial started by ${actor.user.tag}`);
  } catch (e) {
    return err(
      interaction,
      `Discord refused the role change: \`${e.message}\`. Check the bot's role sits above the rank roles.`
    );
  }

  const endsAt = Date.now() + days * DAY;
  db.setRank(interaction.guildId, user.id, R.ranks[0].key, actor.id);
  db.startTrial(interaction.guildId, user.id, endsAt);
  db.addAudit(interaction.guildId, actor.id, user.id, 'trial_start', `${days} day trial`);

  const embed = new EmbedBuilder()
    .setColor(config.colors.promote)
    .setAuthor({ name: `${user.username} is now on trial`, iconURL: user.displayAvatarURL() })
    .setDescription(
      `**${R.ranks[0].name}** for **${days} days**.\nReview card posts automatically <t:${Math.floor(endsAt / 1000)}:R>.`
    )
    .addFields(
      { name: 'User', value: `<@${user.id}>`, inline: true },
      { name: 'Started by', value: `<@${actor.id}>`, inline: true }
    )
    .setTimestamp();

  await receipt(interaction, `**${user.username}** is on a ${days}-day trial as ${R.ranks[0].name}`, {
    announced: Boolean(config.announcements?.onHire),
  });
  await logAction(interaction.guild, embed);

  // Public staff-movements post. Note it says nothing about the trial being
  // a trial period with a pass/fail at the end — that's between them and the
  // staff team, and announcing it invites members to score them too.
  if (config.announcements?.onHire) {
    await announce(
      interaction.guild,
      buildMovement({
        guild: interaction.guild,
        userId: user.id,
        username: user.username,
        avatarURL: user.displayAvatarURL(),
        fromRank: null,                 // no rank yet -> shows the Member side
        toRank: R.ranks[0],
        note: interaction.options.getString('note'),
        kind: 'hire',
        color: config.colors.promote,
      })
    );
  }

  await tryDM(user, {
    embeds: [
      new EmbedBuilder()
        .setColor(config.colors.promote)
        .setTitle(`Welcome to the team in ${interaction.guild.name}`)
        .setDescription(
          `You're on a **${days} day trial** as ${R.ranks[0].name}.\n\n` +
            `**What's tracked:** tickets you claim and close, how fast you reply to them, mod actions, and how many days you actually show up. Senior staff also vouch at the end.\n\n` +
            `**Two things worth knowing.** Showing up consistently beats one big burst — the system counts distinct active days on purpose. And claim tickets before working them; that's how the bot knows the work was yours.\n\n` +
            `None of this is secret. Ask any ${R.rankByKey(config.permissions.review)?.name ?? 'staff member'} to run \`/review\` on you whenever you like and they can show you exactly where you stand.`
        ),
    ],
  });
}

async function extend(interaction, actor) {
  const user = interaction.options.getUser('user');
  const days = interaction.options.getInteger('days');
  const reason = interaction.options.getString('reason') ?? 'No reason given';

  const row = db.getStaff(interaction.guildId, user.id);
  if (!row?.trial_ends_at) return err(interaction, `**${user.username}** is not on a trial.`);

  const base = Math.max(row.trial_ends_at, Date.now());
  const newEnd = base + days * DAY;
  db.setTrialEnd(interaction.guildId, user.id, newEnd);
  db.setTrialState(interaction.guildId, user.id, 'active');
  db.addAudit(interaction.guildId, actor.id, user.id, 'trial_extend', `+${days}d: ${reason}`);

  const embed = new EmbedBuilder()
    .setColor(config.colors.neutral)
    .setAuthor({ name: `${user.username}'s trial extended`, iconURL: user.displayAvatarURL() })
    .setDescription(`+${days} days — now ends <t:${Math.floor(newEnd / 1000)}:R>.\n\n${reason}`)
    .setTimestamp();

  await receipt(interaction, `**${user.username}**'s trial extended by ${days} days`);
  await logAction(interaction.guild, embed);
}

async function end(interaction, actor) {
  const user = interaction.options.getUser('user');
  const row = db.getStaff(interaction.guildId, user.id);
  if (!row?.trial_started_at) return err(interaction, `**${user.username}** is not on a trial.`);

  const { embed, score } = buildReviewCard(interaction.guild, row, user);
  db.setTrialState(interaction.guildId, user.id, 'awaiting_review');
  db.addAudit(interaction.guildId, actor.id, user.id, 'trial_end', 'ended manually');

  // The card carries scores and vouch verdicts — it belongs in the reviews
  // channel, not wherever the command happened to be typed.
  const posted = await postToReviews(interaction.guild, { embeds: [embed] });

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(config.colors.neutral)
        .setDescription(
          `✅ Trial ended for **${user.username}** — scored **${score}/100**.\n\n` +
            (posted && config.channels.reviews
              ? `_Full scorecard posted in <#${config.channels.reviews}>._`
              : '_Could not reach the reviews channel — check `channels.reviews` in config.js._')
        ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function list(interaction) {
  const rows = db.listTrials(interaction.guildId);
  if (!rows.length) {
    return ok(
      interaction,
      new EmbedBuilder().setColor(config.colors.neutral).setDescription('No trials in progress.'),
      { ephemeral: true }
    );
  }

  const lines = rows.map((r) => {
    const ends = r.trial_ends_at ? `<t:${Math.floor(r.trial_ends_at / 1000)}:R>` : 'no end date';
    const flag = r.trial_state === 'awaiting_review' ? ' 🔔 **needs a decision**' : '';
    return `• <@${r.user_id}> — ends ${ends}${flag}`;
  });

  return ok(
    interaction,
    new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setTitle(`Trials in progress (${rows.length})`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Run /review on anyone to see their scorecard' }),
    { ephemeral: true }
  );
}

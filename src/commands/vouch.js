const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, logAction } = require('../util');
const { summariseVouches } = require('../scoring');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vouch')
    .setDescription('Cast your senior-staff vote — on a trial, or on someone ready for the next rank')
    .addUserOption((o) => o.setName('user').setDescription('Who you are vouching on').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('verdict')
        .setDescription('Your call')
        .setRequired(true)
        .addChoices(
          { name: 'Yes — promote them', value: 'yes' },
          { name: 'No — not ready', value: 'no' },
          { name: 'Abstain — I have not worked with them', value: 'abstain' }
        )
    )
    .addStringOption((o) =>
      o.setName('reason').setDescription('Short note — shown on the review card')
    ),

  async execute(interaction) {
    const actor = interaction.member;
    if (!R.meetsRequirement(actor, config.permissions.vouch)) {
      return err(interaction, 'Only senior staff can cast vouches.');
    }

    const user = interaction.options.getUser('user');
    const verdict = interaction.options.getString('verdict');
    const reason = interaction.options.getString('reason');

    if (user.id === interaction.user.id) {
      return err(interaction, "You can't vouch for yourself.");
    }

    const row = db.getStaff(interaction.guildId, user.id);
    if (!row) {
      return err(
        interaction,
        `**${user.username}** isn't tracked as staff — run \`/sync\` if they hold a rank role.`
      );
    }

    // A vouch means different things at different points on the ladder, and
    // the KEY it is stored under has to match, or votes bleed between them.
    //
    //   on trial   → keyed to the trial. "Do we keep them?"
    //   ranked     → keyed to their current rank. "Ready for the next one?"
    //
    // Keying ranked vouches to rank_since is what makes them reset on every
    // promotion. Carrying them forward would let one vote promote someone
    // twice, which is exactly the failure this whole system exists to avoid.
    const onTrial = ['active', 'midpoint_posted', 'awaiting_review'].includes(row.trial_state ?? '');
    const rankIdx = R.indexOfKey(row.rank_key);
    const next = R.ranks[rankIdx + 1] ?? null;

    if (!onTrial && !next) {
      return err(
        interaction,
        `**${user.username}** is at **${R.rankByKey(row.rank_key)?.name ?? row.rank_key}** — the top of the ladder. There is no rank to vouch them into.`
      );
    }

    const cycle = onTrial ? row.trial_started_at : row.rank_since;
    const question = onTrial
      ? 'keeping them on at the end of their trial'
      : `promoting them to **${next.name}**`;

    const existing = db.getVouches(interaction.guildId, user.id, cycle);
    const had = existing.find((v) => v.voucher_id === interaction.user.id);

    db.putVouch(interaction.guildId, user.id, interaction.user.id, cycle, verdict, reason);
    const after = summariseVouches(db.getVouches(interaction.guildId, user.id, cycle));

    // Vouches are private by design: a public tally makes people vote with
    // the room instead of with their judgement.
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(config.colors.neutral)
          .setDescription(
            `${had ? 'Vouch updated' : 'Vouch recorded'} for <@${user.id}>: **${verdict}**\n` +
              `_You are voting on ${question}._\n\n` +
              `Tally so far: **${after.yes} yes · ${after.no} no · ${after.abstain} abstain** ` +
              `(need ${config.scoring.vouches.minimum} minimum).\n` +
              `_Only you can see this — vouches are private until the review card is posted._`
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });

    db.addAudit(interaction.guildId, interaction.user.id, user.id, 'vouch', verdict);

    await logAction(
      interaction.guild,
      new EmbedBuilder()
        .setColor(config.colors.neutral)
        .setDescription(
          `🗳️ <@${interaction.user.id}> ${had ? 'changed their' : 'cast a'} vouch on <@${user.id}> — ` +
            `**${after.total}** vouch${after.total === 1 ? '' : 'es'} in total.`
        )
        .setFooter({ text: 'Verdicts stay hidden until the review card' })
    );
  },
};

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, receipt, logAction, announce, tryDM } = require('../util');
const { buildMovement } = require('../movement');

// The `note:` option replaces the default `-#` subtext under the public
// movement post. Naming the default in the description means the person
// running the command can see what they are overriding.
const noteDesc = (kind) => {
  const d = config.announcements?.defaultNotes?.[kind];
  const base = 'Public subtext under the movement post';
  return (d ? `${base}. Default: "${d}"` : `${base} (no default set)`).slice(0, 100);
};


module.exports = {
  data: new SlashCommandBuilder()
    .setName('promote')
    .setDescription('Move a staff member up one rank (or to a specific rank)')
    .addUserOption((o) =>
      o.setName('user').setDescription('Who to promote').setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('reason')
        .setDescription('Why — PRIVATE, goes to the staff log and their DM only')
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('note')
        .setDescription(noteDesc('promote'))
        .setRequired(false)
        .setMaxLength(150)
    )
    .addStringOption((o) =>
      o
        .setName('rank')
        .setDescription('Skip straight to a rank instead of moving up one')
        .setRequired(false)
        .addChoices(...R.ranks.map((r) => ({ name: r.name, value: r.key })))
    ),

  async execute(interaction) {
    const actor = interaction.member;
    if (!R.meetsRequirement(actor, config.permissions.manageStaff)) {
      return err(interaction, `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to promote people.`);
    }

    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const explicitRank = interaction.options.getString('rank');
    const publicNote = interaction.options.getString('note');

    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!target) return err(interaction, 'That user is not in this server.');
    if (target.user.bot) return err(interaction, 'Bots do not get ranks.');

    const currentIdx = R.memberRankIndex(target);
    const destIdx = explicitRank ? R.indexOfKey(explicitRank) : currentIdx + 1;

    if (destIdx >= R.ranks.length) {
      return err(interaction, `**${user.username}** is already at the top of the ladder.`);
    }
    if (destIdx <= currentIdx) {
      return err(
        interaction,
        `That is not a promotion — use \`/demote\` if you meant to move them down.`
      );
    }

    const blocked = R.checkActionAllowed(actor, target, destIdx);
    if (blocked) return err(interaction, blocked);

    const from = currentIdx >= 0 ? R.ranks[currentIdx].name : 'not staff';
    const to = R.ranks[destIdx];

    try {
      await R.applyRank(target, destIdx, `Promoted by ${actor.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return err(
        interaction,
        `Discord refused the role change: \`${e.message}\`.\nUsually this means the bot's own role is not above the rank roles in Server Settings → Roles.`
      );
    }

    // setRank returns the record as it was BEFORE the change — that's where
    // "how long they held the old rank" comes from.
    const previous = db.setRank(interaction.guildId, user.id, to.key, actor.id);
    // Promoting off Trial resolves the trial
    const row = db.getStaff(interaction.guildId, user.id);
    if (row?.trial_state && ['active', 'midpoint_posted', 'awaiting_review'].includes(row.trial_state)) {
      db.clearTrial(interaction.guildId, user.id, 'passed');
    }
    db.addAudit(interaction.guildId, actor.id, user.id, 'promote', `${from} → ${to.name}: ${reason}`);

    const embed = new EmbedBuilder()
      .setColor(config.colors.promote)
      .setAuthor({ name: `${user.username} promoted`, iconURL: user.displayAvatarURL() })
      .setDescription(`**${from}** → **${to.name}**`)
      .addFields(
        { name: 'Reason', value: reason },
        { name: 'By', value: `<@${actor.id}>`, inline: true },
        { name: 'User', value: `<@${user.id}>`, inline: true }
      )
      .setTimestamp();

    // Ephemeral — the reason must not land in whatever channel this was run in.
    await receipt(interaction, `**${user.username}**: ${from} → **${to.name}**`, {
      announced: Boolean(config.announcements?.onPromote),
    });
    await logAction(interaction.guild, embed);

    // Public staff-movements post — the private `reason` is never included.
    if (config.announcements?.onPromote) {
      await announce(
        interaction.guild,
        buildMovement({
          guild: interaction.guild,
          userId: user.id,
          username: user.username,
          avatarURL: user.displayAvatarURL(),
          fromRank: currentIdx >= 0 ? R.ranks[currentIdx] : null,
          toRank: to,
          note: publicNote,
          kind: 'promote',
          color: config.colors.promote,
        })
      );
    }

    await tryDM(user, {
      embeds: [
        new EmbedBuilder()
          .setColor(config.colors.promote)
          .setTitle(`You've been promoted in ${interaction.guild.name}`)
          .setDescription(`**${from}** → **${to.name}**\n\n${reason}`),
      ],
    });
  },
};

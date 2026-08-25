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
    .setName('demote')
    .setDescription('Move a staff member down one rank, or remove them from staff entirely')
    .addUserOption((o) => o.setName('user').setDescription('Who to demote').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('reason')
        .setDescription('Why — PRIVATE, goes to the staff log and their DM only')
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName('note')
        .setDescription(noteDesc('demote'))
        .setRequired(false)
        .setMaxLength(150)
    )
    .addStringOption((o) =>
      o
        .setName('rank')
        .setDescription('Drop them straight to a specific rank')
        .setRequired(false)
        .addChoices(...R.ranks.map((r) => ({ name: r.name, value: r.key })))
    )
    .addBooleanOption((o) =>
      o
        .setName('remove')
        .setDescription('Remove from staff completely instead of stepping down')
        .setRequired(false)
    ),

  async execute(interaction) {
    const actor = interaction.member;
    if (!R.meetsRequirement(actor, config.permissions.manageStaff)) {
      return err(interaction, `You need to be ${R.rankByKey(config.permissions.manageStaff)?.name} or above to demote people.`);
    }

    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const explicitRank = interaction.options.getString('rank');
    const removeAll = interaction.options.getBoolean('remove') ?? false;
    const publicNote = interaction.options.getString('note');

    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!target) return err(interaction, 'That user is not in this server.');

    const currentIdx = R.memberRankIndex(target);
    if (currentIdx < 0) return err(interaction, `**${user.username}** is not staff.`);

    let destIdx;
    if (removeAll) destIdx = -1;
    else if (explicitRank) destIdx = R.indexOfKey(explicitRank);
    else destIdx = currentIdx - 1; // -1 here means "off the bottom" = removed

    if (destIdx >= currentIdx) {
      return err(interaction, 'That is not a demotion — use `/promote` instead.');
    }

    const blocked = R.checkActionAllowed(actor, target, destIdx >= 0 ? destIdx : null);
    if (blocked) return err(interaction, blocked);

    const from = R.ranks[currentIdx].name;
    const to = destIdx >= 0 ? R.ranks[destIdx].name : 'Removed from staff';

    try {
      await R.applyRank(target, destIdx, `Demoted by ${actor.user.tag}: ${reason}`);
    } catch (e) {
      console.error(e);
      return err(
        interaction,
        `Discord refused the role change: \`${e.message}\`.\nCheck the bot's role is above the rank roles in Server Settings → Roles.`
      );
    }

    if (destIdx >= 0) {
      db.setRank(interaction.guildId, user.id, R.ranks[destIdx].key, actor.id);
      const row = db.getStaff(interaction.guildId, user.id);
      if (row?.trial_state && ['active', 'midpoint_posted', 'awaiting_review'].includes(row.trial_state)) {
        db.clearTrial(interaction.guildId, user.id, 'failed');
      }
    } else {
      db.removeStaff(interaction.guildId, user.id);
    }
    db.addAudit(interaction.guildId, actor.id, user.id, 'demote', `${from} → ${to}: ${reason}`);

    const embed = new EmbedBuilder()
      .setColor(config.colors.demote)
      .setAuthor({ name: `${user.username} demoted`, iconURL: user.displayAvatarURL() })
      .setDescription(`**${from}** → **${to}**`)
      .addFields(
        { name: 'Reason', value: reason },
        { name: 'By', value: `<@${actor.id}>`, inline: true },
        { name: 'User', value: `<@${user.id}>`, inline: true }
      )
      .setTimestamp();

    // Ephemeral, and doubly so here — a demotion reason read out in public
    // is the worst possible way for the rest of the server to find out.
    const ann0 = config.announcements ?? {};
    await receipt(interaction, `**${user.username}**: ${from} → **${to}**`, {
      announced: Boolean(destIdx >= 0 ? ann0.onDemote : ann0.onRemove),
    });
    await logAction(interaction.guild, embed);

    // Departures are OFF by default. When they are on, the public post is
    // deliberately bare: no reason, no actor, no rank they fell from. The
    // point is to stop members speculating about a colour change, not to
    // publish someone's worst day.
    const ann = config.announcements ?? {};
    const wantsPublic = destIdx >= 0 ? ann.onDemote : ann.onRemove;
    if (wantsPublic) {
      await announce(
        interaction.guild,
        buildMovement({
          guild: interaction.guild,
          userId: user.id,
          username: user.username,
          avatarURL: user.displayAvatarURL(),
          fromRank: R.ranks[currentIdx],
          toRank: destIdx >= 0 ? R.ranks[destIdx] : null,
          note: publicNote,
          kind: destIdx >= 0 ? 'demote' : 'remove',
          color: config.colors.demote,
        })
      );
    }

    await tryDM(user, {
      embeds: [
        new EmbedBuilder()
          .setColor(config.colors.demote)
          .setTitle(`Staff change in ${interaction.guild.name}`)
          .setDescription(`**${from}** → **${to}**\n\n${reason}`),
      ],
    });
  },
};

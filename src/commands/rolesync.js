'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const R = require('../ranks');
const roleSync = require('../roleSync');
const { err } = require('../util');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rolesync')
    .setDescription('Discord roles to in-game LuckPerms groups')
    .addSubcommand((s) =>
      s.setName('status').setDescription('What is mapped, and whether it is on')
    )
    .addSubcommand((s) =>
      s
        .setName('check')
        .setDescription('What one person is entitled to right now')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('run')
        .setDescription('Re-check everyone — use after changing roles while the bot was down')
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.manageStaff)) {
      return err(interaction, 'Staff only.');
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return status(interaction);
    if (sub === 'check') return check(interaction);
    if (sub === 'run') return run(interaction);
  },
};

async function status(interaction) {
  const mappings = roleSync.activeMappings();
  const embed = new EmbedBuilder()
    .setColor(roleSync.enabled() ? config.colors.promote : config.colors.neutral)
    .setTitle(roleSync.enabled() ? 'Role sync is on' : 'Role sync is off')
    .setDescription(
      mappings.length
        ? mappings
            .map(
              (m) =>
                `**${m.group}** ← ${roleSync
                  .roleIdsOf(m)
                  .map((id) => `<@&${id}>`)
                  .join(' or ')}`
            )
            .join('\n')
        : '_No mapping has both a group and a role id yet._'
    );

  if (!roleSync.enabled()) {
    embed.addFields({
      name: 'To turn it on',
      value:
        'Set `tempest.enabled` and `tempest.roleSync.enabled` in `config.js`, and ' +
        '`role-sync.enabled` in the plugin\'s `discord.yml`.',
    });
  }
  embed.setFooter({
    text: 'The plugin only grants groups listed in its own managed-groups.',
  });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function check(interaction) {
  const user = interaction.options.getUser('user');
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) return err(interaction, 'They are not in this server.');

  const groups = roleSync.groupsFor(member);
  return interaction.reply({
    content: groups.length
      ? `<@${user.id}> is entitled to: \`${groups.join('`, `')}\``
      : `<@${user.id}> is entitled to no mapped groups.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function run(interaction) {
  if (!roleSync.enabled()) return err(interaction, 'Role sync is off.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { checked, changed } = await roleSync.reconcileAll(interaction.guild);
    return interaction.editReply(
      `Checked ${checked} member(s); ${changed} entitlement(s) changed. ` +
        'The server applies them on its next sweep, or when the player joins.'
    );
  } catch (e) {
    return interaction.editReply(`That failed: ${e.message}`);
  }
}

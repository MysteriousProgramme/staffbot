const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, ok } = require('../util');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription("Map a Minecraft username to a Discord account so in-game chat counts")
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Link a Minecraft username to someone')
        .addUserOption((o) => o.setName('user').setDescription('Discord account').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('ign')
            .setDescription('Their exact Minecraft username')
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(16)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Unlink a Minecraft username')
        .addStringOption((o) =>
          o.setName('ign').setDescription('The Minecraft username').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Every linked name, and which staff are still missing one')
    ),

  async execute(interaction) {
    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'set') return set(interaction);
    if (sub === 'remove') return remove(interaction);
    if (sub === 'list') return list(interaction);
  },
};

async function set(interaction) {
  const user = interaction.options.getUser('user');
  const ign = interaction.options.getString('ign').trim();

  if (!/^[A-Za-z0-9_]{3,16}$/.test(ign)) {
    return err(
      interaction,
      `\`${ign}\` isn't a valid Minecraft username — 3–16 characters, letters, numbers and underscores only.`
    );
  }

  const existing = db.resolveGameName(interaction.guildId, ign);
  if (existing && existing !== user.id) {
    return err(
      interaction,
      `**${ign}** is already linked to <@${existing}>. Run \`/link remove ign:${ign}\` first if that's wrong.`
    );
  }

  db.linkGameName(interaction.guildId, ign, user.id, interaction.user.id);
  db.addAudit(interaction.guildId, interaction.user.id, user.id, 'link', `IGN ${ign}`);

  const tracked = Boolean(db.getStaff(interaction.guildId, user.id));
  return ok(
    interaction,
    new EmbedBuilder()
      .setColor(config.colors.promote)
      .setDescription(
        `🔗 **${ign}** → <@${user.id}>\n\n` +
          (tracked
            ? 'Their in-game chat now counts toward in-game presence.'
            : `_They aren't tracked as staff, so this does nothing yet. It'll start counting the moment they're hired._`)
      ),
    { ephemeral: true }
  );
}

async function remove(interaction) {
  const ign = interaction.options.getString('ign').trim();
  const gone = db.unlinkGameName(interaction.guildId, ign);
  if (!gone) return err(interaction, `**${ign}** wasn't linked to anyone.`);

  return ok(
    interaction,
    new EmbedBuilder()
      .setColor(config.colors.neutral)
      .setDescription(`Unlinked **${ign}**. Their in-game chat stops counting from now on.`),
    { ephemeral: true }
  );
}

async function list(interaction) {
  const links = db.listLinks(interaction.guildId);
  const staff = db.listStaff(interaction.guildId);
  const linkedIds = new Set(links.map((l) => l.user_id));
  const missing = staff.filter((s) => !linkedIds.has(s.user_id));

  const embed = new EmbedBuilder()
    .setColor(missing.length ? config.colors.borderline : config.colors.promote)
    .setTitle(`${links.length} Minecraft name${links.length === 1 ? '' : 's'} linked`);

  embed.setDescription(
    links.length
      ? links
          .slice(0, 30)
          .map((l) => `\`${l.ign}\` → <@${l.user_id}>`)
          .join('\n')
      : '_Nobody is linked yet._ Run `/link set` for each staff member.'
  );

  if (missing.length) {
    embed.addFields({
      name: `⚠️ ${missing.length} staff member(s) with no Minecraft name`,
      value:
        missing
          .slice(0, 20)
          .map((s) => `<@${s.user_id}>`)
          .join(' ') +
        '\n\nThey score **0** for in-game presence until linked, which will drag their review card down unfairly.',
    });
  }

  return ok(interaction, embed, { ephemeral: true });
}

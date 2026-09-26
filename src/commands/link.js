const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const config = require('../../config');
const db = require('../db');
const R = require('../ranks');
const { err, ok } = require('../util');
const tempest = require('../tempest');

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
    )
    .addSubcommand((s) =>
      s
        .setName('code')
        .setDescription('Link your own account with the code the server showed you')
        .addStringOption((o) =>
          o
            .setName('code')
            .setDescription('The 6-character code from the kick screen — capitals matter')
            .setRequired(true)
            .setMinLength(6)
            .setMaxLength(12)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // Anyone may redeem their own code — that is the whole point of the gate. The other
    // subcommands edit someone else's mapping, so they stay staff-only.
    if (sub === 'code') return redeem(interaction);

    if (!R.meetsRequirement(interaction.member, config.permissions.review)) {
      return err(interaction, 'Staff only.');
    }
    if (sub === 'set') return set(interaction);
    if (sub === 'remove') return remove(interaction);
    if (sub === 'list') return list(interaction);
  },
};

/**
 * Redeems a link code issued by the Minecraft server.
 *
 * The plugin owns the decision — it checks the code, enforces one account per Discord user,
 * and carries any punishment record across on a relink. All this does is carry the request
 * and mirror the result into the bot's own scoring map.
 */
async function redeem(interaction) {
  if (!tempest.enabled()) {
    return err(
      interaction,
      'The Minecraft integration is turned off, so codes cannot be redeemed here.'
    );
  }
  const code = interaction.options.getString('code').trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let result;
  try {
    result = await tempest.redeemLinkCode(
      interaction.user.id, interaction.user.tag, code, skipsCooldown(interaction.member));
  } catch (e) {
    return interaction.editReply(`Could not reach the Minecraft server: ${e.message}`);
  }

  if (!result.ok) {
    return interaction.editReply(tempest.explainLink(result));
  }

  // The plugin is now the source of truth for the link. The bot keeps its own IGN map for
  // chat attribution, so mirror it across or in-game presence would silently score zero.
  let account = null;
  try {
    account = await tempest.linkedAccount(interaction.user.id);
  } catch {
    // Non-fatal: the link itself succeeded.
  }
  if (account && account.name) {
    try {
      db.linkGameName(interaction.guildId, account.name, interaction.user.id, 'link-code');
      db.addAudit(interaction.guildId, interaction.user.id, interaction.user.id, 'link',
        `IGN ${account.name} (code)`);
    } catch {
      // Same again — scoring is a nice-to-have, the link is the thing that mattered.
    }
  }

  const embed = new EmbedBuilder()
    .setColor(config.colors.promote)
    .setTitle('Linked')
    .setDescription(
      account && account.name
        ? `Your Discord account is linked to **${account.name}**. Reconnect to the server to play.`
        : 'Your account is linked. Reconnect to the server to play.'
    );

  return interaction.editReply({ embeds: [embed] });
}

/**
 * Whether this member skips the link cooldown and the failed-code rate limit.
 *
 * Only the bot can see Discord roles, so this answer can only come from here — the plugin has
 * no way to ask. It trusts the flag for these two limits and nothing else, and only while its
 * own relink.trust-bot-bypass is on.
 */
function skipsCooldown(member) {
  const ids = config.tempest?.bypassCooldownRoleIds ?? [];
  return ids.some((id) => member?.roles?.cache?.has(id));
}

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
  const lines = [`🔗 **${ign}** → <@${user.id}>`, ''];

  // The bot's own map only drives scoring. Ask the server for the real link too, so that
  // `/link set` means the same thing everywhere — without it a staff member links someone,
  // sees it confirmed, and the player is still refused at the gate with nothing to explain
  // why.
  if (tempest.enabled()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // First account becomes their link; any after that becomes an alt.
    //
    // The plugin keeps one link per Discord account on purpose — the punishment record,
    // the identity and what a relink carries across all hang off it, and two links would
    // make "which account does this ban attach to" a question with no answer. An alt gets
    // through the join gate instead, which is the part somebody with a second account
    // actually needs, and leaves the record where it belongs.
    let held = null;
    try {
      held = await tempest.linkedAccount(user.id);
    } catch {
      // Treated as "no link", so the attempt below decides rather than this lookup. The
      // plugin refuses a second link anyway, so guessing wrong costs a clear error and
      // not a wrong write.
    }

    let result;
    const asAlt = Boolean(held?.name) && held.name.toLowerCase() !== ign.toLowerCase();
    try {
      result = asAlt
        ? await tempest.setAlt(interaction.user.id, user.id, user.tag, ign, true)
        : await tempest.adminLink(interaction.user.id, user.id, user.tag, ign);
    } catch (e) {
      result = { ok: false, message: `Could not reach the Minecraft server: ${e.message}` };
    }

    if (result.ok && asAlt) {
      lines.push(
        `Added as an **alt** of **${held.name}**, so they can join on it.`,
        '_Punishments and history stay on their linked account._'
      );
    } else if (result.ok) {
      lines.push('Linked on the Minecraft server too, so they can join now.');
    } else {
      lines.push(`**${asAlt ? 'Alt not added' : 'Not linked'} on the Minecraft server.** `
        + tempest.explainLink(result, ign));
    }
  } else {
    lines.push('_The Minecraft integration is off, so this only affects scoring._');
  }

  lines.push('', tracked
    ? 'Their in-game chat now counts toward in-game presence.'
    : `_They aren't tracked as staff, so scoring does nothing yet. It'll start the moment they're hired._`);

  const embed = new EmbedBuilder()
    .setColor(config.colors.promote)
    .setDescription(lines.join('\n'));

  // deferReply above means the usual ok() helper would be replying to an answered
  // interaction.
  if (interaction.deferred) return interaction.editReply({ embeds: [embed] });
  return ok(interaction, embed, { ephemeral: true });
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

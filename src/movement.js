const { EmbedBuilder } = require('discord.js');
const config = require('../config');

/**
 * Renders a public staff-movement post.
 *
 * 'line' style reproduces the shape a person types by hand:
 *
 *     @itzharis12345    __**Voluntary Tester**__  >  __**Member**__
 *     -# Trial Started.
 *
 * Rank names are underlined bold. The second line uses Discord's `-# `
 * subtext prefix so it renders small and grey under the movement.
 *
 * The subtext is either the optional `note:` typed on the command, or the
 * default for that kind of movement (see config.announcements.defaultNotes).
 * It is NEVER the private `reason:` — that stays in the staff log.
 */

const isId = (v) => /^\d{15,20}$/.test(String(v));

/** Are role mentions allowed at all? Default: no — underlined bold names. */
const useMentions = () => config.announcements?.mentionRoles === true;

/** How a rank name is decorated on the line. */
const label = (text) => `__**${text}**__`;

function roleRef(rank) {
  if (!rank) return null;
  if (useMentions() && rank.roleId) return `<@&${rank.roleId}>`;
  return rank.name ? label(rank.name) : null;
}

/** Left-hand side for someone who holds no rank yet. */
function memberSide(guild) {
  const text = config.announcements?.memberLabel;
  if (!text) return null;

  if (isId(text)) {
    if (useMentions()) return `<@&${text}>`;
    // Mentions are off but an ID was configured — look the name up so the
    // line reads "Member" rather than a raw snowflake.
    return label(guild?.roles?.cache?.get(String(text))?.name ?? 'Member');
  }
  return label(text);
}

/** The subtext line under the movement. */
function subtext(note, kind) {
  const fallback = config.announcements?.defaultNotes?.[kind];
  const text = (note ?? fallback ?? '').trim();
  if (!text) return null;
  // Strip any leading "-#" the person typed themselves so we never double it.
  return `-# ${text.replace(/^-#\s*/, '')}`;
}

/**
 * @param {object} opts
 * @param {string}      opts.userId
 * @param {object|null} opts.fromRank  rank object, or null for a new hire
 * @param {object|null} opts.toRank    rank object, or null for a removal
 * @param {string|null} opts.note      optional public one-liner from `note:`
 * @param {string}      opts.kind      hire | promote | demote | remove
 * @param {object}      [opts.guild]   used to resolve a memberLabel role ID
 */
function buildMovement({ userId, username, avatarURL, fromRank, toRank, note, kind, color, guild }) {
  const a = config.announcements ?? {};
  const left = roleRef(fromRank) ?? memberSide(guild);
  const right = roleRef(toRank) ?? label(a.removedLabel || 'Removed');
  const sub = subtext(note, kind);

  const movement = [left, '>', right].filter(Boolean).join('  ');

  if (a.style === 'embed') {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: username, iconURL: avatarURL || undefined })
      .setDescription([`<@${userId}>`, movement, sub].filter(Boolean).join('\n'))
      .setTimestamp();
    return { embeds: [embed], allowedMentions: mentions(userId) };
  }

  // 'line' — plain content, no embed, so it sits in the channel like a
  // hand-typed post rather than a bot card.
  const head = `<@${userId}>    ${movement}`;
  const content = sub ? `${head}\n${sub}` : head;

  return { content, allowedMentions: mentions(userId) };
}

/**
 * Ping the member if configured; never ping a role, ever.
 * Even with mentionRoles on, the pills render without notifying anyone —
 * a promotion to Staff would otherwise ping every Staff member.
 */
function mentions(userId) {
  return {
    users: config.announcements?.mentionMember ? [userId] : [],
    roles: [],
    parse: [],
  };
}

module.exports = { buildMovement };

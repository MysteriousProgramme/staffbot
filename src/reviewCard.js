const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const db = require('./db');
const { computeScore, summariseVouches, verdict } = require('./scoring');
const { rankByKey, indexOfKey, ranks } = require('./ranks');
const observe = require('./observe');
const standing = require('./standing');

const fmtDays = (ms) => Math.max(0, Math.round(ms / 86400000));

/**
 * Builds the scorecard embed. Used by /review, the midpoint check and the
 * automatic end-of-trial post, so all three always look identical.
 */
function buildReviewCard(guild, staffRow, user, { midpoint = false } = {}) {
  const from = staffRow.trial_started_at ?? staffRow.hired_at;
  const to = Date.now();

  const metrics = db.getMetrics(guild.id, staffRow.user_id, from, to);
  const { score, breakdown, skipped } = computeScore(metrics);
  const vouchRows = db.getVouches(guild.id, staffRow.user_id, from);
  const vouches = summariseVouches(vouchRows);
  const v = verdict(score, vouches);

  const rank = rankByKey(staffRow.rank_key);
  const nextIdx = indexOfKey(staffRow.rank_key) + 1;
  const next = ranks[nextIdx];

  const elapsed = fmtDays(to - from);
  const total = staffRow.trial_ends_at ? fmtDays(staffRow.trial_ends_at - from) : null;

  const embed = new EmbedBuilder()
    .setColor(midpoint ? config.colors.neutral : v.color)
    .setAuthor({
      name: `${user.username} — ${midpoint ? 'Mid-trial check-in' : 'Trial review'}`,
      iconURL: user.displayAvatarURL?.() || undefined,
    })
    .setTitle(midpoint ? `Progress: ${score}/100` : `${v.label} — ${score}/100`)
    .setDescription(
      midpoint
        ? `Halfway through. Nothing is decided yet — this is so you can course-correct them while there's still time.\n\n${v.reason}`
        : v.reason
    )
    .addFields({
      name: 'Where they stand',
      value: [
        `Rank: **${rank?.name ?? staffRow.rank_key}**${next ? ` → next is **${next.name}**` : ''}`,
        `Trial: day **${elapsed}**${total ? ` of ${total}` : ''}`,
      ].join('\n'),
      inline: false,
    });

  // Metric breakdown, weakest first
  const lines = breakdown.map((b) => {
    const pct = Math.round(b.pct * 100);
    const cmp = b.direction === 'lower' ? 'target under' : 'of';
    return `\`${b.bar}\` **${b.label}** — ${b.display} (${cmp} ${b.targetDisplay}, ${pct}%, worth ${b.weightPct}%)`;
  });
  embed.addFields({ name: 'Scorecard', value: lines.join('\n') || '_no metrics enabled_' });

  if (skipped?.length) {
    embed.addFields({
      name: 'Not scored',
      value: `${skipped.join(', ')} — no data yet, so the other metrics were reweighted to fill 100% rather than scoring this as a zero.`,
    });
  }

  // Vouches
  let vouchText;
  if (vouches.total === 0) {
    vouchText = `_No vouches cast yet._ Senior staff: run \`/vouch user:@${user.username} verdict:...\``;
  } else {
    const detail = vouches.rows
      .slice(0, 8)
      .map((r) => {
        const icon = r.verdict === 'yes' ? '✅' : r.verdict === 'no' ? '❌' : '➖';
        return `${icon} <@${r.voucher_id}>${r.reason ? ` — ${r.reason.slice(0, 120)}` : ''}`;
      })
      .join('\n');
    const ratioText =
      vouches.ratio === null ? 'no decisive votes' : `${Math.round(vouches.ratio * 100)}% in favour`;
    vouchText = `**${vouches.yes} yes · ${vouches.no} no · ${vouches.abstain} abstain** (${ratioText})\n${detail}`;
  }
  embed.addFields({ name: 'Senior staff vouches', value: vouchText });

  // Leave changes how the whole card should be read, so say so up top.
  const loa = db.activeLoa(guild.id, staffRow.user_id);
  const loaDays = db.loaDaysInWindow(guild.id, staffRow.user_id, from, to);
  if (loa || loaDays) {
    embed.addFields({
      name: loa ? '🌙 Currently on leave' : '🌙 Was on leave during this period',
      value: loa
        ? `Back <t:${Math.floor(loa.end_at / 1000)}:R>. Their trial deadline was extended by the same amount — the numbers below cover a period they were away for, so read them gently.`
        : `**${loaDays} day${loaDays === 1 ? '' : 's'}** of this window were leave. The deadline was extended to compensate, but anything time-based below still includes those days.`,
    });
  }

  // When they're actually around, at a glance (UTC).
  const bar = observe.coverageBar(guild.id, staffRow.user_id, from, to);
  if (bar) {
    embed.addFields({
      name: 'When they are around (UTC)',
      value: `\`${bar}\`\n\`0     6     12    18  23\`\n_hour of day, UTC — a flat middle means nobody covers those hours_`,
    });
  }

  // A few real lines, so tone is judged on evidence rather than vibes.
  if (config.conduct?.enabled) {
    const sample = observe.conductSample(guild.id, staffRow.user_id, 6);
    if (sample.length) {
      const lines = sample
        .map((r) => {
          const where = r.source === 'minecraft' ? '⛏️' : `<#${r.channel_id}>`;
          return `${where} ${r.content.slice(0, 120)}`;
        })
        .join('\n');
      embed.addFields({
        name: `How they talk — ${sample.length} of ${db.countConduct(guild.id, staffRow.user_id)} sampled lines`,
        value: lines.slice(0, 1020),
      });
    }
  }

  // Notes
  const notes = db.getNotes(guild.id, staffRow.user_id, 6);
  if (notes.length) {
    const noteText = notes
      .map((n) => `${n.kind === 'praise' ? '🟢' : '🟠'} <@${n.author_id}>: ${n.body.slice(0, 140)}`)
      .join('\n');
    embed.addFields({ name: 'Notes from the team', value: noteText });
  }

  embed.setFooter({
    text: midpoint
      ? 'Mid-trial snapshot · the bot never promotes anyone on its own'
      : 'Recommendation only — a human still runs /promote or /demote',
  });

  return { embed, score, vouches, v, metrics };
}

/**
 * The scorecard for everyone ABOVE Trial Staff.
 *
 * Same evidence, different question. A trial card asks "should this end in a
 * promotion or a goodbye?" and is read once. This one asks "are they holding
 * their rank, and are they ready for the next?" and is read whenever someone
 * wonders — so it leads with direction of travel rather than a pass mark.
 */
function buildStandingCard(guild, staffRow, user, { days = null } = {}) {
  const a = standing.assess(guild.id, staffRow, { days });
  const v = a.verdict;

  const arrow = a.delta === null ? '' : a.delta > 0 ? `▲ +${a.delta}` : a.delta < 0 ? `▼ ${a.delta}` : '▬ 0';

  const embed = new EmbedBuilder()
    .setColor(v.color)
    .setAuthor({
      name: `${user.username} — standing, last ${a.windowDays} days`,
      iconURL: user.displayAvatarURL?.() || undefined,
    })
    .setTitle(`${v.label} — ${a.score}/100${arrow ? `  ${arrow}` : ''}`)
    .setDescription(v.reason);

  // Where they are on the ladder, and whether the clock has run.
  const tenureLine = a.atTop
    ? `In rank **${a.tenureDays} days** · top of the ladder`
    : a.tenureNeeded
      ? `In rank **${a.tenureDays} days** of the **${a.tenureNeeded}** expected before ${a.next.name}${a.tenureMet ? ' ✅' : ''}`
      : `In rank **${a.tenureDays} days**`;

  embed.addFields({
    name: 'Where they stand',
    value: [
      `Rank: **${a.rank?.name ?? a.rankKey}**${a.next ? ` → next is **${a.next.name}**` : ''}`,
      tenureLine,
      a.previous
        ? `Previous ${a.windowDays} days: **${a.previous.score}/100** → now **${a.score}/100**`
        : '_No comparable previous window — this is the first read on them._',
    ].join('\n'),
  });

  // Expectations for this rank, in words, so the numbers have a sentence
  // attached. A scorecard without one gets argued with.
  const profile = standing.profileFor(a.rankKey);
  if (profile?.expects) {
    embed.addFields({ name: `What ${a.rank?.name ?? 'this rank'} is for`, value: `_${profile.expects}_` });
  }

  const lines = a.breakdown.map((b) => {
    const pct = Math.round(b.pct * 100);
    const cmp = b.direction === 'lower' ? 'target under' : 'of';
    return `\`${b.bar}\` **${b.label}** — ${b.display} (${cmp} ${b.targetDisplay}, ${pct}%, worth ${b.weightPct}%)`;
  });
  embed.addFields({
    name: `Scorecard — ${a.rank?.name ?? a.rankKey} targets`,
    value: lines.join('\n').slice(0, 1020) || '_no metrics enabled_',
  });

  if (a.skipped?.length) {
    embed.addFields({
      name: 'Not scored',
      value: `${a.skipped.join(', ')} — no data in this window, so the rest were reweighted to fill 100%.`,
    });
  }

  // Vouches mean something different up here: "ready for the next rank",
  // not "keep them". Say so, or people vote on the wrong question.
  if (!a.atTop) {
    let vouchText;
    if (a.vouches.total === 0) {
      vouchText = `_None cast since they became ${a.rank?.name ?? 'this rank'}._ Senior staff: \`/vouch user:@${user.username}\` means **ready for ${a.next.name}** — not "keep them".`;
    } else {
      const detail = a.vouches.rows
        .slice(0, 8)
        .map((r) => {
          const icon = r.verdict === 'yes' ? '✅' : r.verdict === 'no' ? '❌' : '➖';
          return `${icon} <@${r.voucher_id}>${r.reason ? ` — ${r.reason.slice(0, 120)}` : ''}`;
        })
        .join('\n');
      vouchText =
        `**${a.vouches.yes} yes · ${a.vouches.no} no · ${a.vouches.abstain} abstain** ` +
        `(need ${config.scoring.vouches.minimum})\n${detail}`;
    }
    embed.addFields({ name: `Vouches for ${a.next.name}`, value: vouchText.slice(0, 1020) });
  }

  // When someone is slipping, the useful thing is not the number — it is how
  // long this has been true and whether anybody has said anything to them.
  if (a.escalation?.action && a.escalation.action !== 'none') {
    const e = a.escalation;
    embed.addFields({
      name: e.action === 'review' ? `⚠️ Step ${e.step + 1} of ${e.of}` : `Step ${e.step + 1} of ${e.of} — have the conversation`,
      value:
        e.text +
        (e.spokenTo
          ? ''
          : '\n\n_Nothing is logged against them. The bot will keep saying "talk to them" until a `/note kind:concern` exists — that is the record that stops this becoming a surprise demotion._'),
    });
  }

  if (a.loaDays) {
    embed.addFields({
      name: a.loaHeavy ? '🌙 Mostly on leave this window' : '🌙 Some leave this window',
      value: `**${a.loaDays}** of these ${a.windowDays} days were approved leave.${
        a.loaHeavy ? ' Nothing above is being held against them.' : ''
      }`,
    });
  }

  const bar = observe.coverageBar(guild.id, staffRow.user_id, a.from, a.to);
  if (bar) {
    embed.addFields({
      name: 'When they are around (UTC)',
      value: `\`${bar}\`\n\`0     6     12    18  23\``,
    });
  }

  const notes = db.getNotes(guild.id, staffRow.user_id, 5);
  if (notes.length) {
    embed.addFields({
      name: 'Notes from the team',
      value: notes
        .map((n) => `${n.kind === 'praise' ? '🟢' : '🟠'} <@${n.author_id}>: ${n.body.slice(0, 140)}`)
        .join('\n')
        .slice(0, 1020),
    });
  }

  embed.setFooter({
    text: 'Rolling window · nobody is promoted or demoted by the bot · /staffstats for the raw numbers',
  });

  return { embed, assessment: a, score: a.score, v };
}

module.exports = { buildReviewCard, buildStandingCard };

const { AttachmentBuilder } = require('discord.js');

/**
 * Ticket transcripts.
 *
 * Renders the whole conversation into one self-contained HTML file with no
 * external assets, so it stays readable years later from a Discord CDN link,
 * an email, or a folder on somebody's desktop. That matters for the things
 * tickets actually get used for — appeals and reports, where "what exactly was
 * said" is the entire question.
 */

// Discord's own limit for a normal upload is 8 MB. Stopping well short means a
// pathological ticket produces a truncated transcript rather than no
// transcript at all, which is the wrong way round to fail.
const MAX_MESSAGES = 3000;

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const stamp = (ts) =>
  new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** Oldest first, which is the order a human reads a conversation in. */
async function fetchAll(channel) {
  const out = [];
  let before;

  while (out.length < MAX_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
    if (!batch.size) break;
    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  return out.reverse();
}

function renderMessage(m) {
  const bits = [];

  if (m.content) {
    // Newlines are the only formatting worth preserving here; running the
    // content through a full Markdown renderer would mean parsing untrusted
    // text, and the point of this file is fidelity, not prettiness.
    bits.push(`<div class="body">${esc(m.content).replace(/\n/g, '<br>')}</div>`);
  }

  for (const e of m.embeds ?? []) {
    const parts = [];
    if (e.title) parts.push(`<div class="etitle">${esc(e.title)}</div>`);
    if (e.description) parts.push(`<div>${esc(e.description).replace(/\n/g, '<br>')}</div>`);
    for (const f of e.fields ?? []) {
      parts.push(`<div class="efield"><b>${esc(f.name)}</b><br>${esc(f.value).replace(/\n/g, '<br>')}</div>`);
    }
    if (parts.length) bits.push(`<div class="embed">${parts.join('')}</div>`);
  }

  for (const a of m.attachments?.values() ?? []) {
    // The URL is a signed CDN link that expires. Recording the filename and
    // size means the transcript still says what was attached once it does.
    bits.push(
      `<div class="attach">📎 <a href="${esc(a.url)}">${esc(a.name)}</a> ` +
        `<span class="dim">(${Math.round((a.size ?? 0) / 1024)} KB)</span></div>`
    );
  }

  if (!bits.length) bits.push('<div class="dim body">[no text content]</div>');

  const name = m.member?.displayName ?? m.author?.username ?? 'unknown';
  const bot = m.author?.bot ? '<span class="bot">BOT</span>' : '';

  return (
    `<div class="msg">` +
    `<div class="meta"><span class="who">${esc(name)}</span>${bot}` +
    `<span class="dim"> ${esc(m.author?.id ?? '')} · ${stamp(m.createdTimestamp)}</span></div>` +
    bits.join('') +
    `</div>`
  );
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin:0; padding:24px; background:#1e1f22; color:#dbdee1;
         font:14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .head { border-bottom:1px solid #3f4147; padding-bottom:16px; margin-bottom:16px; }
  .facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:6px 16px; margin-top:12px; }
  .fact b { color:#f2f3f5; }
  .msg { padding:8px 0; border-bottom:1px solid #2b2d31; }
  .meta { font-size:12px; margin-bottom:2px; }
  .who { color:#f2f3f5; font-weight:600; }
  .bot { background:#5865f2; color:#fff; font-size:10px; padding:1px 4px;
         border-radius:3px; margin-left:6px; vertical-align:middle; }
  .dim { color:#949ba4; }
  .body { white-space:pre-wrap; word-wrap:break-word; }
  .embed { border-left:3px solid #5865f2; background:#2b2d31; padding:8px 12px;
           margin:6px 0; border-radius:0 4px 4px 0; }
  .etitle { font-weight:600; color:#f2f3f5; margin-bottom:4px; }
  .efield { margin-top:6px; }
  .attach { margin-top:4px; }
  a { color:#00a8fc; }
  .note { color:#949ba4; font-size:12px; margin-top:16px; }
`;

function renderHtml(channel, ticket, messages, truncated) {
  const facts = [
    ['Ticket', `#${ticket.number ?? '?'}`],
    ['Channel', `#${channel.name}`],
    ['Type', ticket.type_key ?? '—'],
    ['Priority', ticket.priority ?? 'normal'],
    ['Opened by', ticket.opener_id ?? 'unknown'],
    ['Claimed by', ticket.claimed_by ?? 'never claimed'],
    ['Credited to', ticket.credited_to ?? 'nobody'],
    ['Opened', stamp(ticket.opened_at)],
    ['Closed', stamp(Date.now())],
    ['Messages', String(messages.length)],
  ];

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>Ticket #${esc(ticket.number)} · ${esc(channel.name)}</title>` +
    `<style>${STYLE}</style></head><body><div class="wrap">` +
    `<div class="head"><h1>Ticket #${esc(ticket.number)}</h1>` +
    (ticket.subject ? `<div class="dim">${esc(ticket.subject)}</div>` : '') +
    `<div class="facts">` +
    facts.map(([k, v]) => `<div class="fact">${esc(k)}: <b>${esc(v)}</b></div>`).join('') +
    `</div></div>` +
    (truncated
      ? `<div class="note">Only the most recent ${MAX_MESSAGES} messages are included.</div>`
      : '') +
    messages.map(renderMessage).join('') +
    `<div class="note">Generated by Staffbot.</div>` +
    `</div></body></html>`
  );
}

/**
 * Build the transcript attachment for a ticket channel.
 * Throws if the history cannot be read; the caller decides what that means.
 */
async function build(channel, ticket) {
  const messages = await fetchAll(channel);
  const html = renderHtml(channel, ticket, messages, messages.length >= MAX_MESSAGES);
  return new AttachmentBuilder(Buffer.from(html, 'utf8'), {
    name: `ticket-${String(ticket.number ?? channel.id)}.html`,
    description: `Transcript of #${channel.name}`,
  });
}

module.exports = { build, renderHtml, MAX_MESSAGES };

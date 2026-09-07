'use strict';

/**
 * Staffbot dashboard.
 *
 * Plain DOM, no framework, no build step — the bot ships three dependencies and
 * runs on a free-tier box, and a toolchain to render four tabs would weigh more
 * than the bot.
 *
 * Everything is built with createElement and textContent rather than innerHTML.
 * Half of what is rendered here is text somebody typed into Discord — ticket
 * subjects, nicknames, note bodies — and this page can promote people.
 */

const $ = (id) => document.getElementById(id);

/** el('div.card', {onclick}, 'text', childNode, ...) */
function el(spec, props, ...kids) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');

  if (props && (typeof props !== 'object' || props instanceof Node)) {
    kids.unshift(props);
  } else if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'onclick') node.addEventListener('click', v);
      else if (k === 'onchange') node.addEventListener('change', v);
      else if (k === 'oninput') node.addEventListener('input', v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'html') throw new Error('no innerHTML here');
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }

  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/**
 * append() that drops null/false, so a conditional child can be written inline.
 * The DOM's own append() stringifies null into a visible 'null'.
 */
function add(node, ...kids) {
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

// ---------------------------------------------------------------
// Transport
// ---------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    method: options.method ?? 'GET',
    headers: options.body
      ? { 'Content-Type': 'application/json', 'X-Staffbot': 'dashboard' }
      : options.method && options.method !== 'GET'
        ? { 'X-Staffbot': 'dashboard' }
        : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }

  if (res.status === 401) {
    state.authed = false;
    showLogin();
    throw new Error('Signed out.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

let toastTimer = null;
function toast(message, kind = '') {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'bad' ? 6000 : 3000);
}

const run = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    toast(e.message, 'bad');
  }
};

// ---------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------

function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function until(ts) {
  if (!ts) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s < 0) return 'overdue';
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

const scoreClass = (n) => (n >= 80 ? 'good' : n >= 45 ? 'warn' : 'bad');

function avatar(p) {
  const img = el('img.avatar', { alt: '' });
  if (p?.avatar) img.setAttribute('src', p.avatar);
  return img;
}

const state = {
  authed: false,
  writes: true,
  tab: 'overview',
  selectedStaff: null,
  roles: [],
  channels: [],
  config: null,
  configEdits: {},
};

// ---------------------------------------------------------------
// Overview
// ---------------------------------------------------------------

async function renderOverview() {
  const [ov, tickets, staff] = await Promise.all([
    api('/overview'),
    api('/tickets'),
    api('/staff'),
  ]);

  $('botstatus').textContent = ov.bot.ready
    ? `${ov.bot.tag} · ${ov.bot.guild} · up ${Math.round(ov.bot.uptimeSeconds / 60)}m`
    : 'connecting…';

  const c = ov.counts;
  const tiles = [
    ['Open tickets', c.openTickets, c.unclaimedTickets > 0],
    ['Unclaimed', c.unclaimedTickets, c.unclaimedTickets > 0],
    ['Closed today', c.closedTicketsToday, false],
    ['Staff', c.staff, false],
    ['On trial', c.trials, c.trialsEndingSoon > 0],
    ['On leave', c.onLoa, false],
    ['Blocked', c.blacklisted, false],
  ];

  clear($('tiles')).append(
    ...tiles.map(([k, n, alert]) =>
      el('div.tile' + (alert && n > 0 ? '.alert' : ''), {}, el('div.n', { text: n }), el('div.k', { text: k }))
    )
  );

  const unclaimed = tickets.tickets.filter((t) => !t.claimedBy);
  clear($('ov-unclaimed')).append(
    unclaimed.length
      ? el('div', {}, ...unclaimed.slice(0, 8).map(ticketRow))
      : el('p.empty', { text: 'Everything open has someone on it.' })
  );

  const soon = staff.staff
    .filter((s) => s.onTrial && s.trialEndsAt)
    .sort((a, b) => a.trialEndsAt - b.trialEndsAt)
    .slice(0, 8);

  clear($('ov-trials')).append(
    soon.length
      ? el('div', {}, ...soon.map((s) =>
          el('div.item', { onclick: () => { selectTab('staff'); openStaff(s.id); } },
            avatar(s),
            el('div.grow', {},
              el('div.nm', { text: s.name }),
              el('div.sub', { text: `${s.rankName} · ends ${until(s.trialEndsAt)}` })
            ),
            el('span.score ' + scoreClass(s.score), { text: s.score })
          )
        ))
      : el('p.empty', { text: 'Nobody is on trial.' })
  );
}

// ---------------------------------------------------------------
// Staff
// ---------------------------------------------------------------

async function renderStaff() {
  const { staff } = await api('/staff');
  const list = clear($('staff-list'));

  if (!staff.length) return list.append(el('p.empty', { text: 'No staff registered. Run /sync in Discord.' }));

  for (const s of staff) {
    const badges = [];
    if (s.onTrial) badges.push(el('span.badge.accent', { text: 'trial' }));
    if (s.onLoa) badges.push(el('span.badge', { text: 'leave' }));

    list.append(
      el('div.item' + (state.selectedStaff === s.id ? '.on' : ''),
        { onclick: () => openStaff(s.id) },
        avatar(s),
        el('div.grow', {},
          el('div.nm', { text: s.name }),
          el('div.sub', { text: s.rankName })
        ),
        ...badges,
        el('span.score ' + scoreClass(s.score), { text: s.score })
      )
    );
  }
}

const openStaff = run(async (userId) => {
  state.selectedStaff = userId;
  await renderStaff();

  const d = await api('/staff/' + encodeURIComponent(userId));
  const box = clear($('staff-detail'));

  box.append(
    el('div.row.gap', {},
      avatar(d),
      el('div.grow', {},
        el('h1', { text: d.name }),
        el('div.dim', { text: `${d.rankName} · since ${ago(d.rankSince)} · hired ${ago(d.hiredAt)}` })
      ),
      el('div.score ' + scoreClass(d.score), { text: d.score })
    )
  );

  if (d.onTrial) {
    box.append(
      el('p', {},
        el('span.badge.accent', { text: 'on trial' }), ' ',
        el('span.dim', { text: `ends ${until(d.trialEndsAt)} · ${d.windowDays} days measured` }),
        d.verdict ? el('span.badge.' + (d.verdict.code === 'ready' ? 'good' : d.verdict.code === 'below_bar' ? 'bad' : 'warn'), { text: d.verdict.label }) : null
      )
    );
    if (d.verdict?.reason) box.append(el('p.dim', { text: d.verdict.reason }));
  } else if (d.standing && !d.standing.error) {
    box.append(el('p.dim', { text: `Standing over ${d.windowDays} days.` }));
  }

  if (d.adjustment) {
    box.append(el('p.dim', { text: `Manual adjustments: ${d.adjustment > 0 ? '+' : ''}${d.adjustment} (raw score ${d.rawScore})` }));
  }

  // ---- metric breakdown, weakest first ----
  box.append(el('h3', { text: 'Measured' }));
  for (const m of d.breakdown) {
    const pct = Math.round(m.pct * 100);
    const bar = el('div.bar', {}, el('i.' + scoreClass(pct), {}));
    // CSSOM assignment, not setAttribute('style') — the Content-Security-Policy
    // blocks style attributes but not programmatic style changes.
    bar.firstChild.style.width = pct + '%';
    box.append(
      el('div.metric', {},
        el('div.top', {},
          el('span', { text: `${m.label} · ${m.weightPct}%` }),
          el('span.dim', { text: `${m.display} / ${m.targetDisplay}` })
        ),
        bar
      )
    );
  }

  if (d.ticketStats?.handled) {
    box.append(el('p.dim', { text: `${d.ticketStats.handled} tickets credited · ${d.ticketStats.claimed ?? 0} claimed · ${d.ticketStats.firstReplies ?? 0} first replies` }));
  }

  if (d.vouches.length) {
    box.append(el('h3', { text: 'Vouches' }));
    for (const v of d.vouches) {
      box.append(el('div.item', {},
        el('div.grow', {}, el('div.nm', { text: v.name }), v.reason ? el('div.sub', { text: v.reason }) : null),
        el('span.badge.' + (v.verdict === 'yes' ? 'good' : v.verdict === 'no' ? 'bad' : ''), { text: v.verdict })
      ));
    }
  }

  if (d.notes.length) {
    box.append(el('h3', { text: 'Notes' }));
    for (const n of d.notes) {
      box.append(el('div.item', {},
        el('div.grow', {},
          el('div.nm', { text: n.body }),
          el('div.sub', { text: `${n.author.name} · ${ago(n.created_at)}` })
        ),
        el('span.badge.' + (n.kind === 'praise' ? 'good' : n.kind === 'concern' ? 'bad' : ''), { text: n.kind })
      ));
    }
  }

  if (d.audit.length) {
    box.append(el('h3', { text: 'History' }));
    for (const a of d.audit.slice(0, 8)) {
      box.append(el('div.item', {},
        el('div.grow', {},
          el('div.nm', { text: a.action }),
          el('div.sub', { text: `${a.detail ?? ''} · ${ago(a.created_at)}` })
        )
      ));
    }
  }

  if (state.writes) box.append(staffActions(d));
});

function staffActions(d) {
  const wrap = el('div', {}, el('h3', { text: 'Actions' }));

  const reason = el('textarea', { placeholder: 'Reason — private, goes to the log and their DM' });
  const rankSel = el('select', {});
  for (const r of state.config?.ranks ?? []) rankSel.append(el('option', { value: r.key, text: r.name }));
  rankSel.value = d.rankKey;

  const move = (kind) => run(async () => {
    if (!reason.value.trim()) throw new Error('Write a reason first.');
    const res = await api(`/staff/${encodeURIComponent(d.id)}/${kind}`, {
      method: 'POST',
      body: { rank: rankSel.value, reason: reason.value.trim() },
    });
    toast(`${d.name}: ${res.from} → ${res.to ?? 'removed'}`, 'good');
    reason.value = '';
    openStaff(d.id);
  });

  wrap.append(
    reason,
    el('div.row.gap', {},
      rankSel,
      el('button', { onclick: move('promote'), text: 'Promote to' }),
      el('button', { onclick: move('demote'), text: 'Demote to' })
    )
  );

  // ---- trial ----
  const days = el('input', { type: 'number', value: 14, min: 1, max: 90 });
  days.style.width = '70px';
  const trial = (op) => run(async () => {
    await api(`/staff/${encodeURIComponent(d.id)}/trial`, {
      method: 'POST',
      body: { op, days: Number(days.value) },
    });
    toast('Trial updated.', 'good');
    openStaff(d.id);
  });

  wrap.append(
    el('h3', { text: 'Trial' }),
    el('div.row.gap', {},
      days,
      el('button.mini', { onclick: trial('start'), text: 'Start' }),
      el('button.mini', { onclick: trial('extend'), text: 'Extend' }),
      el('button.mini', { onclick: trial('end'), text: 'End now' })
    )
  );

  // ---- note + vouch ----
  const noteBody = el('input', { placeholder: 'Note' });
  const noteKind = el('select', {},
    el('option', { value: 'neutral', text: 'neutral' }),
    el('option', { value: 'praise', text: 'praise' }),
    el('option', { value: 'concern', text: 'concern' })
  );

  wrap.append(
    el('h3', { text: 'Log a note' }),
    el('div.row.gap', {},
      noteBody, noteKind,
      el('button.mini', {
        text: 'Add',
        onclick: run(async () => {
          await api(`/staff/${encodeURIComponent(d.id)}/note`, {
            method: 'POST',
            body: { kind: noteKind.value, body: noteBody.value },
          });
          noteBody.value = '';
          toast('Note added.', 'good');
          openStaff(d.id);
        }),
      })
    )
  );

  const vouchReason = el('input', { placeholder: 'Why (optional)' });
  const vouch = (v) => run(async () => {
    await api(`/staff/${encodeURIComponent(d.id)}/vouch`, {
      method: 'POST',
      body: { verdict: v, reason: vouchReason.value || null },
    });
    toast('Vouch recorded.', 'good');
    openStaff(d.id);
  });

  wrap.append(
    el('h3', { text: 'Vouch' }),
    el('div.row.gap', {},
      vouchReason,
      el('button.mini', { onclick: vouch('yes'), text: 'Yes' }),
      el('button.mini', { onclick: vouch('no'), text: 'No' }),
      el('button.mini', { onclick: vouch('abstain'), text: 'Abstain' })
    )
  );

  return wrap;
}

// ---------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------

function ticketRow(t) {
  const pri = { low: '', normal: '', high: 'warn', urgent: 'bad' }[t.priority] ?? '';

  return el('div.item', {},
    avatar(t.opener),
    el('div.grow', {},
      el('div.nm', { text: `#${String(t.number).padStart(4, '0')} · ${t.subject || t.typeLabel || 'ticket'}` }),
      el('div.sub', {
        text: `${t.opener?.name ?? 'unknown'} · opened ${ago(t.openedAt)} · ${t.messages} msgs`,
      })
    ),
    pri ? el('span.badge.' + pri, { text: t.priority }) : null,
    t.escalatedAt ? el('span.badge.warn', { text: 'escalated' }) : null,
    t.claimedBy
      ? el('span.badge.good', { text: t.claimedBy.name })
      : el('span.badge.warn', { text: 'unclaimed' })
  );
}

async function renderTickets() {
  const [{ tickets }, { blacklist }] = await Promise.all([api('/tickets'), api('/blacklist')]);
  const list = clear($('ticket-list'));

  if (!tickets.length) {
    list.append(el('p.empty', { text: 'No open tickets.' }));
  } else {
    for (const t of tickets) {
      const row = ticketRow(t);

      if (state.writes) {
        const pri = el('select.mini', {});
        for (const p of ['low', 'normal', 'high', 'urgent']) pri.append(el('option', { value: p, text: p }));
        pri.value = t.priority;
        pri.addEventListener('change', run(async () => {
          await api(`/tickets/${encodeURIComponent(t.channelId)}/priority`, {
            method: 'POST', body: { level: pri.value },
          });
          toast('Priority updated.', 'good');
          renderTickets();
        }));

        add(row,
          pri,
          t.claimedBy
            ? el('button.mini', {
                text: 'Unclaim',
                onclick: run(async () => {
                  await api(`/tickets/${encodeURIComponent(t.channelId)}/unclaim`, { method: 'POST' });
                  toast('Unclaimed.', 'good');
                  renderTickets();
                }),
              })
            : null,
          el('button.mini.danger', {
            text: 'Close',
            onclick: run(async () => {
              const why = prompt(`Close ticket #${t.number}? Optional resolution note:`);
              if (why === null) return;
              const res = await api(`/tickets/${encodeURIComponent(t.channelId)}/close`, {
                method: 'POST', body: { reason: why || null },
              });
              toast(`Closed. Credited ${res.credited.length ? res.credited.length + ' staff' : 'nobody'}.`, 'good');
              renderTickets();
            }),
          })
        );
      }

      list.append(row);
    }
  }

  // ---- blacklist ----
  const bl = clear($('blacklist'));
  if (!blacklist.length) {
    bl.append(el('p.empty', { text: 'Nobody is blocked.' }));
  } else {
    for (const b of blacklist) {
      add(bl, el('div.item', {},
        avatar(b),
        el('div.grow', {},
          el('div.nm', { text: b.name }),
          el('div.sub', { text: `${b.reason || 'no reason given'} · by ${b.by.name} · ${ago(b.createdAt)}` })
        ),
        state.writes
          ? el('button.mini', {
              text: 'Unblock',
              onclick: run(async () => {
                await api('/blacklist/' + encodeURIComponent(b.id), { method: 'DELETE' });
                toast('Unblocked.', 'good');
                renderTickets();
              }),
            })
          : null
      ));
    }
  }

  $('bl-form').hidden = !state.writes;
}

// ---------------------------------------------------------------
// Settings
// ---------------------------------------------------------------

const isRoleKey = (k) => /roleid$/i.test(k) || /roleids$/i.test(k);
const isChannelKey = (k) => /channelid$/i.test(k) || /categoryid$/i.test(k) ||
  ['channels.reviews', 'channels.staffLog', 'channels.staffChannels', 'channels.ignored'].includes(k);

function pickerFor(key, value, onChange) {
  const known = isRoleKey(key) ? state.roles : state.channels;
  const many = Array.isArray(value);

  // A configured ID that is not in the guild any more — a deleted role, or a
  // channel the bot cannot see — must still appear, or the select renders blank
  // and quietly drops the value the moment anything else on the page is saved.
  const held = many ? value : value ? [value] : [];
  const options = [
    ...known,
    ...held.filter((id) => !known.some((o) => o.id === id)).map((id) => ({ id, name: id + ' (not found)' })),
  ];

  if (many) {
    const sel = el('select', { multiple: true, size: Math.min(6, Math.max(3, options.length)) });
    for (const o of options) {
      const opt = el('option', { value: o.id, text: o.name });
      if (value.includes(o.id)) opt.setAttribute('selected', '');
      sel.append(opt);
    }
    sel.addEventListener('change', () =>
      onChange([...sel.selectedOptions].map((o) => o.value))
    );
    return sel;
  }

  const sel = el('select', {}, el('option', { value: '', text: '— none —' }));
  for (const o of options) sel.append(el('option', { value: o.id, text: o.name }));
  sel.value = value ?? '';
  sel.addEventListener('change', () => onChange(sel.value || null));
  return sel;
}

function fieldFor(key, value) {
  const set = (v) => { state.configEdits[key] = v; $('config-status').textContent = 'Unsaved changes'; };

  if (typeof value === 'boolean') {
    const box = el('input', { type: 'checkbox' });
    box.checked = value;
    box.addEventListener('change', () => set(box.checked));
    return box;
  }

  if (isRoleKey(key) || isChannelKey(key)) return pickerFor(key, value, set);

  if (typeof value === 'number') {
    const inp = el('input', { type: 'number', value: String(value) });
    inp.addEventListener('input', () => set(inp.value === '' ? null : Number(inp.value)));
    return inp;
  }

  if (value !== null && typeof value === 'object') {
    // panel settings and ticket types: structured enough that a form per shape
    // would be its own project, simple enough that JSON is honest.
    const area = el('textarea', { rows: 10, spellcheck: 'false' });
    area.value = JSON.stringify(value, null, 2);
    area.addEventListener('input', () => {
      try {
        set(JSON.parse(area.value));
        area.style.outline = '';
      } catch {
        area.style.outline = '2px solid var(--bad)';
        delete state.configEdits[key];
      }
    });
    return area;
  }

  const inp = el('input', { type: 'text', value: value ?? '' });
  inp.addEventListener('input', () => set(inp.value || null));
  return inp;
}

const GROUPS = {
  Tickets: (k) => k.startsWith('tickets.'),
  Channels: (k) => k.startsWith('channels.') || k.startsWith('announcements.') || k === 'staffTeamRoleId',
  Behaviour: () => true,
};

async function renderConfig() {
  const cfg = await api('/config');
  state.config = cfg;
  state.configEdits = {};

  $('config-note').textContent =
    `Saved to ${cfg.overridesPath} — config.js is never rewritten, so git pull stays clean. ` +
    `${cfg.overridden.length} setting(s) currently overridden.`;

  const form = clear($('config-form'));
  const used = new Set();

  for (const [groupName, match] of Object.entries(GROUPS)) {
    const keys = cfg.editable.filter((k) => !used.has(k) && match(k));
    if (!keys.length) continue;
    keys.forEach((k) => used.add(k));

    form.append(el('h3', { text: groupName }));
    for (const key of keys) {
      form.append(
        el('div.field', {},
          el('div.lab', {},
            key.split('.').pop().replace(/([A-Z])/g, ' $1').toLowerCase(),
            el('span.path', { text: key }),
            cfg.overridden.includes(key) ? el('span.over', { text: 'overridden' }) : null
          ),
          el('div', {}, fieldFor(key, cfg.values[key]))
        )
      );
    }
  }

  $('config-save').hidden = !state.writes;
  $('config-restart').hidden = !state.writes;
  $('config-status').textContent = '';
}

// ---------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------

const RENDER = {
  overview: renderOverview,
  staff: renderStaff,
  tickets: renderTickets,
  config: renderConfig,
};

function selectTab(name) {
  state.tab = name;
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === 'tab-' + name);
  run(RENDER[name])();
}

function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
}

async function boot() {
  $('login').hidden = true;
  $('app').hidden = false;

  const [{ roles }, { channels }] = await Promise.all([api('/roles'), api('/channels')]);
  state.roles = roles;
  // 0 = text, 4 = category, 5 = announcement. Anything else cannot be posted in.
  state.channels = channels.filter((c) => [0, 4, 5].includes(c.type));

  const sel = clear($('panel-channel'));
  for (const c of state.channels.filter((c) => c.type !== 4)) {
    sel.append(el('option', { value: c.id, text: '#' + c.name }));
  }

  await api('/config').then((cfg) => (state.config = cfg));
  selectTab('overview');
}

// ---------------------------------------------------------------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('login-err');
  errBox.hidden = true;
  try {
    await api('/login', { method: 'POST', body: { token: $('token').value.trim() } });
    state.authed = true;
    $('token').value = '';
    await boot();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  }
});

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset?.tab;
  if (tab) selectTab(tab);
});

$('bl-add').addEventListener('click', run(async () => {
  const res = await api('/blacklist', {
    method: 'POST',
    body: { userId: $('bl-id').value.trim(), reason: $('bl-reason').value.trim() || null },
  });
  $('bl-id').value = '';
  $('bl-reason').value = '';
  toast(res.warning || 'Blocked.', res.warning ? 'bad' : 'good');
  renderTickets();
}));

$('panel-post').addEventListener('click', run(async () => {
  const res = await api('/panel', { method: 'POST', body: { channelId: $('panel-channel').value } });
  toast(`Panel posted in #${res.posted}.`, 'good');
}));

$('config-save').addEventListener('click', run(async () => {
  const changes = state.configEdits;
  if (!Object.keys(changes).length) return toast('Nothing changed.');
  const res = await api('/config', { method: 'POST', body: { changes } });
  $('config-status').textContent = `Saved ${res.saved.length} setting(s). Restart to be certain everything picked it up.`;
  toast('Saved.', 'good');
  renderConfig();
}));

$('config-restart').addEventListener('click', run(async () => {
  if (!confirm('Restart the bot? It comes straight back under systemd; started by hand, it stops.')) return;
  await api('/restart', { method: 'POST' });
  toast('Restarting — refresh in a few seconds.', 'good');
}));

// Poll the overview so open tickets do not go stale while the tab is open.
setInterval(() => {
  if (state.authed && state.tab === 'overview' && !document.hidden) run(renderOverview)();
}, 20000);

api('/session')
  .then(async (s) => {
    state.writes = s.writes;
    if (s.authed) {
      state.authed = true;
      await boot();
    } else {
      showLogin();
    }
  })
  .catch(showLogin);

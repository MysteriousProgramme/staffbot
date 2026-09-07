# Staffbot

Staff ranks, trial evaluation, ongoing standing reviews, and a built-in ticket system for a Discord server.

- **`/promote` and `/demote`** move people along your ladder, with guardrails so nobody can touch someone at or above their own rank.
- **A dashboard** — a local website for running all of this from a browser instead of typing slash commands. See [The dashboard](#the-dashboard).
- **Tickets** — a dropdown panel members open tickets from, with claiming, escalation, transcripts and a blacklist. Because Staffbot runs them itself, ticket work is measured rather than guessed at.
- **`/trial start`** puts someone on the clock. The bot then measures what they actually do.
- At the end it posts a **scorecard** — objective numbers plus senior-staff vouches — flagged **READY / BORDERLINE / BELOW BAR**.
- **Above the trial**, every ranked staff member gets a rolling **standing** review against their own rank's targets, with a hold bar and a promote bar. See [the standing system](#above-the-trial--the-standing-system).

The bot never promotes anyone by itself. It gives you the answer and the reasoning; a human clicks the button. See [Why it doesn't auto-promote](#why-it-doesnt-auto-promote).

---

## Your ladder

```
Trial Staff  →  Staff  →  Head Staff  →  Mod  →  Head Mod
```

Who can do what, out of the box:

| | Trial | Staff | Head Staff | Mod | Head Mod | Owner / Founder / Co-Owner |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Every command | | | | | ✅ | ✅ |

**Every command is Head Mod and above.** Ranks below Head Mod still hold their roles and are still measured by the bot — they just can't run anything.

On top of that there's one hard rule the code enforces everywhere: **you can never act on someone at or above your own rank, and you can never place someone at your own rank.** So a Head Mod can promote people up to Mod, and only an override role can make someone a Head Mod.

Your Owner / Founder / Co-Owner role IDs go in `permissions.overrideRoleIds` and bypass all of it — **except each other.** All three sit at the same ceiling, so an Owner cannot demote the Founder and vice versa. Only the Discord server owner is above everyone.

**Leadership isn't measured.** If you hold an override role *and* a rank role for the colour, `trackOverrides: false` (the default) keeps you out of the tracked set entirely — no scorecard, no `/link` nag, no effect on staffing counts. You still outrank everyone. Set it to `true` if you genuinely want owners scored.

> **Watch the vouch count.** `/vouch` needs `scoring.vouches.minimum` (2) *distinct* people, and only Head Mods and override-role holders can cast one. If too few people qualify, no trial can ever reach the minimum and every review card parks on **AWAITING VOUCHES** forever. Staffbot counts eligible people on startup and warns loudly if there aren't enough — either lower `permissions.vouch` or lower the minimum.

---

## Setup

### 1. Install Node.js

Get the **LTS** version from [nodejs.org](https://nodejs.org). Restart your PC after installing.

Node 18, 20, 22 and 24 all work. Avoid odd-numbered releases (21, 23, 25) — they are short-lived and the database library often has no prebuilt binary for them, which forces npm to try compiling from source.

### 2. Make the bot application

1. https://discord.com/developers/applications → **New Application**
2. **Bot** tab → **Reset Token** → copy it
3. Same page, turn ON all three **Privileged Gateway Intents**:
   - Server Members Intent
   - Message Content Intent
   - Presence Intent
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`, permissions:
   **Manage Roles**, **View Audit Log**, **Send Messages**, **Manage Messages**, **Read Message History**, **Attach Files**, **Embed Links**
5. Open the generated URL and invite it.

### 3. Move the bot's role up

**Server Settings → Roles**, drag the bot's role **above all five rank roles**. Discord won't let a bot assign a role sitting above its own. This is the number one reason people see "Missing Permissions".

### 4. Fill in your details

Make a **copy** of `.env.example` and rename the copy to exactly `.env`, then fill in the three values.

> Editing `.env.example` itself does nothing — it is only a template and the bot never reads it. This is the most common setup mistake. Then open `config.js` — every ID in there is a placeholder. Turn on **Developer Mode** (User Settings → Advanced) so you can right-click things and Copy ID.

You need:

- role IDs for the five ranks + your Staff Team ping role
- a staff-log channel and a reviews channel
- your public staff-movements channel
- your in-game chat bridge channel
- your staff channel IDs
- the categories your tickets get created in, and a private channel for ticket transcripts

The bot refuses to start if anything important is still a placeholder, and tells you exactly which line.

### 5. Run it

Double-click **`setup.bat`** once. Then **`check.bat`** — it lists every ID you still need to fill in, with a hint for each. When it says *Ready to go*, run **`start.bat`**.

(On Mac/Linux: `npm install && npm run deploy`, then `npm run check`, then `./start.sh`.)

Then in Discord:

```
/sync                    ← registers your existing staff so tracking starts
```

**Running on your PC means the bot is only online while that window is open.** Tracking stops when you close it or shut down, so scores under-count.

To run it 24/7:

- **[DEPLOY-EC2.md](DEPLOY-EC2.md)** — best option. A real always-on Linux box, SQLite works unchanged, free for 12 months on the AWS free tier. Includes a one-shot installer, a systemd service and a backup script.
- **[DEPLOY-RENDER.md](DEPLOY-RENDER.md)** — easier clicking, $7.25/month. Render's *free* tier cannot host this: free instances have no persistent disk, so the database would be wiped on every restart. A static site can't run it at all.

---

## Commands

| Command | Who | What |
|---|---|---|
| `/trial start user: days:` | Head Mod+ | Hire as Trial Staff, start the clock and the tracking |
| `/trial extend user: days:` | Head Mod+ | Not sure yet? Buy more time instead of guessing |
| `/trial end user:` | Head Mod+ | End early and post the card now |
| `/trial list` | Head Mod+ | Every trial running, and who's waiting on a decision |
| `/promote user: reason: [rank:]` | Head Mod+ | Up one rank, or jump to a specific one |
| `/demote user: reason: [rank:] [remove:]` | Head Mod+ | Down one rank, or off the team |
| `/review user: [window:] [public:]` | Head Mod+ | Full scorecard — trial card on a trial, standing card above it |
| `/vouch user: verdict: [reason:]` | Head Mod+ | Your yes/no/abstain — on a trial, or on someone's next rank |
| `/promotions` | Head Mod+ | Who's ready to move up, who's close, who's slipping |
| `/note user: kind: note:` | Head Mod+ | Log something they did well or badly |
| `/deduct user: points: reason: [days:]` | Head Mod+ | Take points off for something the numbers can't see |
| `/increase user: points: reason: [days:]` | Head Mod+ | Add points for DMs, voice, builds, mentoring |
| `/adjustments user: [revoke:]` | Head Mod+ | Read the ledger, or take an entry back off it |
| `/staffstats user: [days:]` | Head Mod+ | Raw numbers over any window, against their own rank's targets |
| `/conduct user: [lines:]` | Head Mod+ | Read a sample of what they've actually been saying |
| `/link set user: ign:` | Head Mod+ | Map a Minecraft username to a Discord account |
| `/link list` | Head Mod+ | Every link, and which staff are missing one |
| `/loa start user: days:` | Head Mod+ | Put someone on leave — pauses the clock, extends their trial |
| `/loa end user:` \| `/loa list` | Head Mod+ | Bring them back / see who's away |
| `/coverage [days:]` | Head Mod+ | When the team is around, and the hours nobody covers |
| `/leaderboard [days:]` | Head Mod+ | Staff ranked by score, with what the bottom is missing |
| `/digest [preview:]` | Head Mod+ | Post the weekly digest now |
| `/sync` | Head Mod+ | Register existing role-holders into the database |
| `/ticketpanel [channel:]` | Head Mod+ | Post the dropdown members open tickets from |
| `/ticket claim` \| `unclaim` | Ticket staff | Take a ticket, or put it back up for grabs |
| `/ticket transfer user:` | Ticket staff | Hand it over — the credit goes with it |
| `/ticket escalate [reason:]` | Ticket staff | Pull in the rank above you |
| `/ticket add user:` \| `remove user:` | Ticket staff | Let someone into the ticket, or out of it |
| `/ticket priority level:` | Ticket staff | low / normal / high / urgent |
| `/ticket rename name:` | Ticket staff | Rename the channel, keeping the number |
| `/ticket close [reason:]` | Ticket staff | Transcript to the log, then the channel goes |
| `/ticket blacklist user: [reason:]` | Head Mod+ | Block someone from opening tickets |
| `/ticket unblacklist user:` \| `blacklisted` | Head Mod+ | Unblock them / list everyone blocked |

### Where rank changes go

There is no private staff-log channel. Every rank change goes to **one** public channel — `announcements.channelId` — as a single line:

```
@example    __**Member**__  >  __**Trial Staff**__
-# Trial Started.
```

Rank names are underlined bold, and the second line uses Discord's `-# ` subtext so it renders small and grey. The only @ on the line is the member being announced — set `mentionRoles: true` for coloured @role pills instead, though even then nobody in those roles is pinged.

The subtext writes itself from `announcements.defaultNotes`:

| Movement | Subtext |
|---|---|
| `/trial start` | `-# Trial Started.` |
| `/promote` | `-# Promoted.` |
| `/demote` | `-# Demoted.` |
| removal | `-# Removed from the staff team.` |

Typing `note:` on the command replaces the default for that one post. Set any entry to `null` for no subtext at all.

**The private `reason:` never appears there.** It goes to the person's DM and into the database. Read it back any time with `/staffstats`, which shows their full rank history with reasons attached — that is now the audit trail. Put a channel ID back in `channels.staffLog` if you ever want it mirrored into a channel again.

### reason vs note

`/promote` and `/demote` take two separate text fields, deliberately:

| | Goes where | For |
|---|---|---|
| `reason:` (required) | their DM + the database | The honest internal record. "Coasting since the trial ended." Read back with `/staffstats`. |
| `note:` (optional) | the public movements line | What the server gets told. "Reinstated." |

The reason **never** reaches the public channel, whatever you switch on. One field is the truth, the other is the announcement — conflating them is how a demotion reason ends up read out in front of 600 members.

| | Recorded privately | Staff movements (public) |
|---|---|---|
| New trial staff | database + DM | movement line + `-# Trial Started.` |
| Promotion | database + DM, with reason | movement line + `-# Promoted.` |
| Demotion | database + DM, with reason | movement line + `-# Demoted.` |
| Removal | database + DM, with reason | *nothing* (unless `onRemove`) |
| Vouch cast | database | never |
| Trial cards | reviews channel | never |

Note the hire line doesn't say "trial". That it's a probation with a pass/fail at the end is between the person and the staff team; announcing it invites members to start scoring them too.

Set `announcements.channelId` to `null` to turn the whole thing off.

---

## The dashboard

Everything above is also a website. Run the bot, open the address it prints, paste the token:

```
[web] dashboard: http://127.0.0.1:8787
[web] token: 3nR9x_KfQ2sVbT8pLmWzYd4Ah
```

Four tabs:

- **Overview** — open tickets, what is unclaimed, trials about to end, who is on leave.
- **Staff** — the roster, and for anyone on it: their score, every metric as a bar against its target (weakest first), vouches, notes, rank history. Promote, demote, start or end a trial, vouch, log a note.
- **Tickets** — every open ticket with its age, priority and claimer. Claim, close, re-prioritise. Manage the blacklist. Post the panel.
- **Settings** — the config, as a form.

It is the same code underneath, not a second implementation: the score on the website is `computeScore` and the promote button is `applyRank`, so the page and the embeds cannot disagree.

### Settings, without SSH

The dashboard never rewrites `config.js`. It writes `data/config.local.json`, which is merged over the top on load:

```
config.js  <  data/config.local.json
```

`data/` is gitignored, so **`git pull` stops fighting your settings** — the committed file stays the defaults, your changes live beside the database, and an override is undone by removing it rather than by hunting through 700 lines. Role and channel fields are dropdowns of what is actually in your server, so there is no ID to copy.

Not everything is editable from the page. Scoring weights, permission ranks and the chat-bridge regexes fail quietly and subtly when they are wrong, and a stray keystroke in a form should not be able to switch off half the scoring system. Those stay in `config.js`, where changing them is deliberate.

Most changes take effect immediately. Some are read once at startup, so there is a **Restart bot** button — under systemd it comes straight back.

### Reaching it from EC2

It binds to `127.0.0.1`, which means the machine it runs on and nowhere else. From your PC, forward the port over SSH:

```bash
ssh -i your-key.pem -L 8787:127.0.0.1:8787 ec2-user@YOUR-INSTANCE-IP
```

Leave that open and browse to `http://localhost:8787`. Nothing is exposed to the internet and the security group is untouched.

**Do not set `web.host` to `0.0.0.0`.** That publishes a page that can promote staff and read message samples onto the network, with one token in front of it. The bot prints a warning if you do. Use the tunnel.

### Security

| | |
|---|---|
| Binding | `127.0.0.1` — loopback only |
| Token | `WEB_TOKEN` in `.env`, or generated each boot and printed |
| Sessions | HttpOnly, SameSite=Strict cookie, 12 hours by default |
| Brute force | 8 attempts, then locked out for 5 minutes |
| Writes | Rejected without a header a cross-site form cannot set |
| Page | Strict CSP, no inline scripts, everything rendered as text not HTML |
| Read-only | `web.allowWrites: false` removes every button and refuses every write |
| Off | `web.enabled: false` |

Actions are attributed to `USER_ID` from `.env` in the audit trail and the staff log, so `/staffstats` shows a person rather than "the bot".

---

## Watching how staff behave, not just how much

Two separate things, kept deliberately apart.

### Presence — where and when, no content

Every time a staff member speaks anywhere, Staffbot records **one row per person/day/channel/hour**. No message text, ever. That gives two things:

- **Channel spread** (6% of the score) — how many different channels they're actually present in. Someone who only ever lurks in one corner scores badly here even if their raw message count is high.
- **A coverage bar** on the review card, showing what hours they're around:

```
 ▄▄█▄          ▄█▄      
0     6     12    18  23
```

Useful when you're deciding who to hire next: if your whole team clusters in the same six hours, the gap is the thing to fix, and this shows it at a glance.

Presence is recorded for **every** channel — including ones in `channels.ignored`. An ignored channel still proves the person was around; the ignore list only affects the scored message counts.

### Conduct — a sample of what they actually said

Numbers tell you whether someone showed up. They tell you nothing about tone. So the review card carries a handful of their real lines:

```
How they talk — 6 of 8 sampled lines
⛏️ on my way to spawn now, hold tight
#general  no worries at all, easy mistake
#general  please read the rules channel before posting again
#general  i can see why that annoyed you, but calling him that is not on
```

`/conduct user:@Jamie lines:15` shows more.

The sample is spread evenly across what's stored rather than taking the most recent few — the last five messages are usually five lines of one conversation, which reads as a single moment rather than a habit.

Minecraft chat is included by default (`conduct.includeGameChat`). How staff talk to players in-game is often the clearest read on tone there is.

### Be straight with your staff about this

This one stores message content in the bot's database. That's a real thing to tell people, not something they should find out.

It's deliberately narrow:

| Setting | Default | |
|---|---|---|
| `onlyDuringTrial` | `true` | Only people currently on trial. Turning this off collects from every staff member permanently — a much bigger promise to make to your team. |
| `sampleSize` | `30` | Rolling. Older lines drop off. |
| `maxLength` | `220` | Each line truncated. |
| `retentionDays` | `45` | Everything auto-purged past this, daily. |
| `excludeChannelIds` | `[]` | Channels never sampled from, whatever else is going on. |

Set `conduct.enabled: false` to switch the whole thing off and keep only the presence metrics, which store no content at all.

The honest framing for your team: *"while you're on trial the bot keeps your last few dozen messages so we can see how you talk to people, and it deletes them after 45 days."* Said upfront that's reasonable. Discovered later it isn't.

---

## In-game chat — DiscordSRV

`gameChat.channelId` points at your DiscordSRV chat channel. On an SMP this is the most honest signal you have: it shows whether a trial actually plays, and how they talk to players.

The problem it solves: those messages are posted by **DiscordSRV**, not by the staff member's Discord account, so the message author tells you nothing. Staffbot works out who is talking from the Minecraft username.

### Getting the name

DiscordSRV's stock formats are:

```
MinecraftChatToDiscordMessageFormat:                "**%primarygroup%** %displayname% » %message%"
MinecraftChatToDiscordMessageFormatNoPrimaryGroup:  "%displayname% » %message%"
```

so what lands in Discord looks like `**Owner** Jamie_MC » hey everyone`. The shipped `namePattern` skips the bolded rank prefix so the capture lands on the **player**, not the group — getting that backwards is the easy mistake, and there's a test asserting it.

Three ways the name is found, in order:

1. **Webhook** — if you turned on `Experiment_WebhookChatMessageDelivery`, DiscordSRV posts through a webhook named after the player, so the webhook name *is* the username. Detected automatically, no pattern involved.
2. **`namePattern`** — the default bot delivery, as above.
3. **Loose fallback** — for nicknames the strict pattern can't express (`xX_Zac_Xx`, names with symbols), it takes whatever sits just before the `»`. Safe, because a name still has to resolve through `/link` to count — a bad guess just fails the lookup.

Joins, leaves, deaths and advancements are sent by DiscordSRV as **embeds with no message content**, so they never reach the parser at all. The `ignorePattern` is belt-and-braces on top of that.

### Linking names

Staffbot needs to know which Minecraft name belongs to which Discord account:

```
/link set user:@Jamie ign:Jamie_MC
/link remove ign:Jamie_MC
/link list
```

`/link list` also shows **which staff have no name linked** — worth checking, because an unlinked person scores 0 for in-game presence and their review card will look worse than they deserve. `/staffstats` warns about it on their card too.

One person can hold several names (alt accounts). Matching is case-insensitive.

### What gets filtered out

`gameChat.ignorePattern` drops join/leave spam, death messages, advancements and `[Server]` broadcasts — they aren't a person talking. Messages shorter than `tracking.minMessageLength` don't count, and one message per person per 45 seconds counts, same as everywhere else.

The bridge channel is excluded from ordinary message tracking, so the bridge bot never registers as your most active staff member.

### If the bridge isn't set up

`inGameActivity` **skips itself** rather than scoring everyone 0 — the other metrics reweight to fill 100%. Same mechanism as response time. So you can turn `gameChat.enabled` off and nothing else breaks.

---

## Keeping the team healthy

Three views that read data already being collected, plus one that runs itself.

### `/loa` — leave of absence

Someone takes exams for a fortnight and their metrics crater through no fault of their own. `/loa start user:@Jamie days:14 reason:exams` fixes that:

- Their **trial deadline moves back by the same number of days**, so they get their full run of active days rather than a fortnight half-spent revising
- They stop appearing in the "gone quiet" list
- Their review card carries a leave banner, so nobody reads a thin scorecard as slacking
- They get a DM saying none of it counts against them

Leave expires on its own; `/loa end` brings someone back early (they keep the extra trial days).

Without this, the scoring system quietly punishes people for having lives — which is exactly how a team stops trusting it.

### `/coverage` — the hours nobody is around

```
Team coverage — last 14 days
`          ███        ███`
`0     6     12    18  23`

⚠️ 2 gaps with nobody around
00:00–10:00 (10h) · 13:00–21:00 (8h)
```

For an SMP with players across timezones this is the most actionable hiring information there is: don't hire another moderator for your busiest hour, hire one for the ten-hour hole.

### `/leaderboard` — scores, ranked

Ephemeral by default and Head Mod+ only, so it isn't a public scoreboard. It also names **what the bottom of the table is actually missing**, because "last place" on its own is not something you can act on.

> A leaderboard is the one feature here that can make things worse. A visible ranking turns your metrics into a competition, and competitions get gamed — you'd be handing the team a scoreboard for the exact numbers you told them not to farm. Keeping it private to leadership is what makes it safe.

### The weekly digest

Posts to your reviews channel every Monday 09:00 UTC. Everything in it is something the bot already knew and nobody was asking:

- Trials ending within 3 days, and any waiting on a decision
- **Ranked staff ready for the next rank, and anyone slipping** (see below)
- Staff unseen for 10+ days (people on leave excluded)
- Tickets unclaimed, or open with no staff reply
- Coverage gaps

`/digest preview:true` shows it to you without posting. `digest.includeLeaderboard` adds the scores — **off by default**, since the digest lands in a channel your team may read.

---

## Above the trial — the standing system

The trial system asks one question, once: *do we keep them?* It answers it and then goes quiet. That left four fifths of your ladder with raw numbers and no opinion about them — a Staff member could sit at the same rank for six months, doing well or doing nothing, and the bot would never mention it either way.

Standing fixes that. Everyone above Trial Staff is scored on a **rolling window** instead of a trial window, against **their own rank's targets**, with **two bars instead of one**:

| | |
|---|---|
| **Hold bar** (45) | Under it, they aren't currently holding up the rank |
| **Promote bar** (80) | Over it, the next rank is worth discussing |

`/review` picks the right card automatically — trial card if they're on a trial, standing card if they aren't. Nobody has to remember which.

### Why per-rank targets

A Head Mod judged on ticket volume is being rewarded for doing the job two rungs below them. So each rank gets its own targets *and* its own weights, in `standing.profiles`:

| Rank | Weighted most on | Ticket target (30d) |
|---|---|---|
| Staff | Tickets (28%), turning up (20%) | 18 |
| Head Staff | Tickets (25%), being the one people ask | 20 |
| Mod | Mod actions (18%), tickets (18%), presence (14%) | 15 |
| Head Mod | **Staff presence (27%)**, mod actions (16%) | 10 |

Read the Head Mod row as the point of the whole thing: by that rank the job is running the team, and someone still grinding tickets instead is doing the rank below.

> The standing targets are for **30 days**, not for a 14-day trial. Reusing the section 6 numbers here would make every ranked staff member look like a superstar. `check.bat` refuses a standing target that isn't above the trial one.

### Three things a trial review never had to do

**Trajectory.** The same window immediately before this one is scored too, so the card shows `▲ +12` or `▼ -9`. A 62 climbing and a 62 falling are entirely different conversations, and one number hides which one you're in.

**Time in rank.** `standing.minTenureDays` — 30 days at Staff, 45 at Head Staff, 60 at Mod. Someone can clear the promote bar in their third week and the card will say **READY, TOO SOON**: *the number says yes, the calendar says wait*. Promotion three weeks into a rank teaches a team that the ladder is climbed by being noticed rather than by doing the work.

**A drift signal, with a guard on it.** Under the hold bar for **two consecutive windows** — not one — before anything is flagged. One quiet month reads as **QUIET WINDOW** and the bot says so plainly: *worth noticing, not worth acting on.* Anyone on leave, including leave approved today, is excused entirely.

### Vouches above the trial

`/vouch` now works on ranked staff, and means something different: **ready for the next rank**, not *keep them*. The card and the command both say which question you're answering.

Ranked vouches are keyed to `rank_since`, so **they reset on every promotion**. Carrying them forward would let one vote promote somebody twice, which is the exact failure this system exists to prevent.

### `/promotions`

The whole ranked team in one view, ephemeral, Head Mod+:

```
⬆️ Ready (1)
@Jamie · Staff → Head Staff
 84/100 · 47d in rank · vouched 3–0

Close (2)
@Kai · Head Staff — 81/100, needs 12 more day(s) in rank
@Rowan · Staff — 83/100, needs 1 more vouch(es)

📉 Slipping (1)
@Sam · Mod — 38/100 (was 41) · weakest: Tickets handled
```

The same three sections post in the weekly digest without anyone running anything. That's the half that actually changes behaviour — otherwise a good Staff member goes unnoticed for six months because nobody thought to check on someone who wasn't a problem.

If it finds nothing, it says so, and says that a settled staff team looking settled is not the bot failing.

### `/staffstats` uses the same yardstick

`/staffstats` scores against **the targets for the rank the person actually holds**, scaled to whatever window you ask for, and says which yardstick it used in the description line.

This matters more than it sounds. Trial-level work scores **100** against the trial targets and **54 / 45 / 46 / 46** against Staff / Head Staff / Mod / Head Mod. Before this, running `/staffstats` on a Head Mod showed a near-perfect card — and the footer told you to calibrate `config.js` from what you were looking at. You'd have raised your trial bar off a number that was never measuring a trial.

The footer now points at the block that produced the numbers: `standing.profiles.<rank>` for ranked staff, `scoring.metrics` for trials. The default window follows suit — a trial defaults to the trial length, ranked staff to their standing window.

### When to demote — and why it isn't a score

**No score demotes anyone, at any rank.** That's a design decision, not an omission:

- The score measures **activity**. Almost every real demotion is about **conduct** — abusing perms, being sharp with members, leaking staff chat, playing favourites — and the score is blind to all of it. Someone can sit at 90 and need removing today.
- A quiet month has a dozen innocent causes. Exams, a new job, illness, a dead PC, a changed timezone, burnout. The bot cannot tell any of those apart from "stopped caring".
- If a number demotes people, the number becomes the job. That's the farming problem wearing a different hat.

So the escalation is counted in **windows, not points**:

| Windows under the hold bar | What the bot says | What you do |
|---|---|---|
| 1 | **QUIET WINDOW** | Nothing. Say nothing. |
| 2 | **DRIFTING** — step 1 of 3 | Ask what changed. If the answer is life, `/loa` is the tool — not `/demote`. |
| 3+, nothing logged | still step 1 | *"Nobody has actually asked them yet."* Management hasn't happened; that isn't their fault. |
| 3+, concern logged | **DRIFTING — REVIEW THE RANK**, step 3 of 3 | A rank change is now defensible. You still run `/demote` yourself, with a reason. |

The third row is the guard that matters. Three bad months and no conversation is a failure of management, not grounds for a demotion — so the bot refuses to escalate until a `/note kind:concern` exists. That note is also what stops a demotion being a surprise: there's a dated record that somebody raised it.

Under `standing.demotion.collapseScore` (20) the wording changes rather than the rule: at that level the question to put to them is whether they still *want* the rank, not whether they can improve it.

**Approved leave stops the clock entirely** — `/loa` resets the streak, so nobody accrues drift while they're away with your blessing.

### `/deduct` and `/increase` — the gap the numbers can't cover

The score measures **activity**. Someone can sit at 90 having done something that should stop a promotion dead, and nothing in the metrics knows. It cuts both ways: the bot can't see a dispute settled in DMs, an hour spent training a new hire in voice, or a build that took someone a weekend.

So both directions exist. But an adjustment here is a **ledger entry, never an edit to the score** — because the number's entire value is that it isn't negotiable. The moment ±15 can be handed out silently, the score stops being a measurement and becomes an opinion wearing a measurement's clothes, and nobody reading it later can tell which parts are which.

Four rules keep it evidence:

| | |
|---|---|
| **Attributed** | Every entry names who issued it and why. A Head Mod who likes someone can still add points — everyone can *see* that they did, which is the part that matters. |
| **Visible** | The card always shows both: `84/100 (measured 96)`, with the full ledger underneath. A score you can't take apart again isn't evidence. |
| **Expiring** | 90 days by default. A deduction for a bad week in March shouldn't still be dragging someone down in September, and nobody ever remembers to remove it by hand. |
| **Capped** | 15 per entry, 30 total. Past that the tool is `/demote`, and the cap says so in the error. |

**The deduction is not the punishment.** An active deduction **blocks a promotion recommendation outright**, whatever the score says — the verdict becomes `ON HOLD — CONDUCT` and names the reason. That's the clean answer to "high points but they did something bad": the promotion stops, and the cause is stated rather than smuggled into the number as arithmetic nobody can read back.

Other guards:

- **They're told.** A DM goes out when an entry is issued, and again when a deduction is revoked. A deduction someone discovers months later from a number is the worst version of this feature.
- **The rank rule applies.** You can't adjust yourself, or anyone at or above your own authority — otherwise `/deduct` would be a way to act on a peer that `/demote` explicitly forbids.
- **Reasons are mandatory** and must be more than a few characters.
- **Revoking is first-class.** `/adjustments user:@x revoke:12` lifts one, DMs them that it's lifted, and leaves the entry in the record marked revoked rather than deleting it.
- **Switching the feature off makes entries inert, not deleted.**

> If you find yourself reaching for `/deduct` repeatedly on the same person, that's the signal — you're using arithmetic to avoid a conversation. Two deductions and a drift flag is a `/note kind:concern` and a talk.

### What is deliberately *not* here

**Conduct sampling still stops at the trial.** `conduct.onlyDuringTrial` stays `true`. Extending message-content collection to your permanent staff, indefinitely, is a much bigger promise to make to your team than a 14-day trial sample — and it's a promise they'd be discovering rather than agreeing to.

**Nothing auto-demotes.** Drift produces a flag, an escalation step and a sentence recommending a conversation. Every rank change is still a human running `/demote`. There is a test asserting the strongest wording the bot can produce still hands the decision to a person.

---

## Tickets

Staffbot runs your tickets itself. It creates the channel, handles the Claim button and closes the thing, which is what makes the ticket half of a trial score trustworthy — nothing here is inferred from another bot's embeds.

### How it works for a member

1. They pick an option from the **dropdown panel** you posted with `/ticketpanel`.
2. If that type asks questions, they get a **form** first, so staff open the channel already knowing the problem.
3. A private channel appears — `#report-0042-wafflvedd` — visible to them and your ticket staff, with the answers pinned at the top.

Channel names come from `tickets.nameFormat`, which defaults to `{type}-{number}-{user}`. The tokens are `{type}`, `{number}`, `{user}` and `{priority}`; everything is lowercased and stripped to what Discord accepts, and a token that resolves to nothing is dropped rather than leaving a dangling dash. High and urgent tickets get a coloured dot in front so they sort to the top of the category — turn that off with `tickets.priorityPrefix: false`.

### How it works for staff

| Action | What it does |
|---|---|
| **Claim** button, or `/ticket claim` | Puts your name on it. This is what decides the credit. |
| **Close** button, or `/ticket close` | Confirm, transcript to the log channel, then the channel goes. |
| `/ticket transfer user:` | Hands it to someone else, and moves the credit with it. |
| `/ticket escalate` | Pings the rank **above you** and moves it to the escalation category. |
| `/ticket add user:` / `remove` | Pull in a witness or a second pair of eyes. |
| `/ticket priority level:` | low / normal / high / urgent. High and urgent get a coloured prefix on the channel name so they sort to the top. |
| `/ticket rename name:` | Rename the channel, keeping the ticket number. |

Anyone holding a rank role, or a role in `tickets.staffRoleIds`, can do all of the above.

### Keeping a type away from the people it is about

By default every role in `tickets.staffRoleIds` can read every ticket. That is wrong in one case in particular: a report about a staff member would be readable by the staff member it is about.

Give a type its own `staffRoleIds` and it **replaces** the global list rather than adding to it:

```js
{
  key: 'staffreport',
  label: 'Report a Staff Member',
  staffRoleIds: [],                  // no rank role sees this at all
  pingRoleIds: [FOUNDER, OWNER],     // only these can read it
  ...
}
```

`pingRoleIds` always gets access on top, so an empty `staffRoleIds` means "only the roles I ping". Omit the field entirely and the type behaves as it always did.

Do not reach for separate categories to solve this. A category organises channels; it does not restrict them. Visibility comes from these two lists and nothing else.

### Who gets the credit

1. **The claimer.** They put their name on it.
2. Otherwise **the staff member who sent the most messages**, provided they cleared `minMessagesToCredit` (default 3).
3. Otherwise **nobody**.

Note this is deliberately not "whoever closed it". Closing is one click and would be the easiest number in the whole system to farm. Doing the talking is not.

`creditEveryone: true` credits every staff member over the threshold instead of just the top one — reasonable if your team genuinely tag-teams tickets, inflationary if they don't.

### Transcripts

When a ticket closes, the whole conversation is rendered into a single self-contained HTML file and posted to `tickets.logChannelId`, alongside who opened it, who claimed it, who got the credit and how long it was open. Then the channel is deleted after `deleteDelaySeconds`.

Set `deleteDelaySeconds: null` to lock and keep the channel instead of deleting it.

> Set `logChannelId` before you go live. Without it, closing a ticket deletes the conversation permanently — which is exactly the wrong outcome for an appeal or a player report. `/ticketpanel` warns you if it is missing.

### Stopping the panel being spammed

- `maxOpenPerUser` (default 1) — how many tickets one person may have open at once.
- `cooldownSeconds` (default 300) — how long they must wait between opening tickets.
- `/ticket blacklist user: reason:` — blocks someone entirely. They are shown your reason when they try.

Blacklisting also hands them the `tickets.blacklistRoleId` role, purely so it is obvious in the member list who is blocked. **The database is the real gate** — stripping that role by hand does not let them open tickets again. `/ticket blacklisted` lists everyone currently blocked.

### Setup

```js
tickets: {
  enabled: true,
  staffRoleIds: ['ROLE_THAT_HANDLES_TICKETS'],
  logChannelId: 'PRIVATE_TRANSCRIPT_CHANNEL',
  escalationCategoryId: null,      // optional
  blacklistRoleId: null,           // optional
  maxOpenPerUser: 1,
  cooldownSeconds: 300,
  deleteDelaySeconds: 15,          // null = lock and keep the channel
  types: [
    { key: 'support', label: 'General Support', categoryId: 'CATEGORY_ID', questions: [...] },
  ],
}
```

Each entry in `types` becomes one option in the dropdown, with its own category, its own roles to ping, and up to **five** form questions (Discord's limit on a form). Then, in a channel members can see:

```
/ticketpanel             ← posts the dropdown
```

The panel message holds no state, so it is disposable: change your types, post a new one, delete the old one. Run `npm run check` first — it lists every ticket ID still missing.

The bot needs **Manage Channels** to create and delete ticket channels. If you invited it before this version existed, re-run `npm run invite` and use the new link; re-inviting a bot that is already in your server just tops up its permissions.

### If the bot is offline

It runs on a PC, so it misses events whenever that PC sleeps. Nobody can open a ticket while it is down — the dropdown does nothing. On startup it settles any ticket whose channel disappeared while it was away, crediting from the message counts it did record.

---

## Still using Ticket King?

The old watcher is still in the box. It does not run your tickets — it watches the **category** another bot creates channels in and works out who handled what from who did the talking:

| What happens | What Staffbot records |
|---|---|
| A channel appears in the category | A ticket opened |
| First staff message in it | Response time for that person |
| Every staff message | A participation count |
| The channel disappears | Ticket closed — credit whoever did the work |

To use it instead of the native system, set `ticketKing.enabled: true` **and `tickets.enabled: false`**. Leaving both on double-counts any category they share, and the bot says so on startup.

Its one fragile part is claim detection: `claimPattern` is a regex matched against Ticket King's own messages, and the first capture group that looks like a user ID is taken as the claimer. If it never matches, nothing breaks — credit falls back to the message count. That fragility is the reason the native system exists.

Staffbot must also be able to see inside those channels: add its role to Ticket King's **support roles**, or grant **View Channel** and **Read Message History** on the category. If it cannot see them, ticket metrics stay at zero and nothing tells you why.

Both kinds of ticket live in the same table and count toward the same metrics, so switching over loses no history.

---

## How the evaluation works

### What gets measured

| Metric | Weight | Target (14d) | Why |
|---|---:|---:|---|
| Tickets handled | 25% | 8 | The actual job. Can't be faked. |
| Active days | 20% | 9 | Distinct days they showed up |
| In-game presence | 18% | 80 | Minecraft chat. The only metric that proves they play. |
| Mod actions | 12% | 5 | Bans, kicks, timeouts, deletes |
| Avg first response | 12% | under 20 min | How long a member waits for a reply |
| Channel spread | 6% | 6 | Distinct channels they're present in |
| Staff channel activity | 4% | 30 | Are they around and talking to the team |
| Public activity | 3% | 100 | Visible to members |

**These are tuned down hard for a server under 1,000 members.** In a quiet server there isn't enough trouble to generate a big mod-action count, so mod actions are worth only 15% with a target of 5 — punishing a trial for a peaceful fortnight would be backwards. Ticket work carries the score instead, because that's what your staff actually do all day.

Every metric caps at 100% of target, so overshooting earns nothing extra.

**Active days is the sleeper metric.** It catches the person who ghosts for twelve days, panics, and grinds everything on day thirteen. They can hit every other target and still score badly, because they were only present twice.

**Response time scores in reverse** — faster is better — and it **skips itself** if the person handled no tickets, rather than scoring them 0%. Their zero tickets already cost them 30% under "tickets handled"; charging them twice for the same absence would be double jeopardy. The remaining metrics reweight to fill 100%.

### What it can't measure

Tone. Judgement under pressure. Whether they escalate instead of guessing. Whether members actually like dealing with them. Whether they're the kind of person who'll abuse a ban button in six months.

That's `/vouch`, and it can veto in both directions:

| | |
|---|---|
| High score + seniors vote **no** | **BELOW BAR** — numbers don't beat a bad read from people who worked with them |
| Low score + everyone votes **yes** | **BELOW BAR** — being well-liked isn't the job |
| High score + vouches pass | **READY** |
| Anything else | **BORDERLINE**, with their weakest metric listed first |

Vouches are private — only the voter sees their own. A visible running tally makes the third person to vote agree with the first two instead of thinking.

### Midpoint check

Halfway through, a progress card posts to your reviews channel. The point is to fix someone while they still can, rather than surprising them with a fail. `trial.midpointCheckAt: null` turns it off.

---

## Tuning

**The default numbers are an educated guess. Calibrate them.**

1. Run `/staffstats user:@a-mod-you-already-trust days:14`
2. That's what "good" looks like in *your* server
3. Set targets slightly below it

Then run `npm test` — several of those checks are assertions about *your* config, not the code. It'll fail loudly if you set a weight high enough that one metric could pass the bar on its own, or if your pass ratio would let a tied vote through.

### On farming, honestly

The moment staff learn there's a score, some will optimise for it. Built-in defences:

- messages under 5 characters don't count
- one counted message per channel per 45 seconds
- every metric caps at its target
- ticket credit follows the claim, not the close
- ticket channels are excluded from message counts, so a chatty ticket can't pay out twice
- `channels.ignored` excludes anywhere you like

But no metric survives someone determined to game it. The real defence is that tickets and active days carry 55% between them, vouches can veto anything, and a human decides.

**Tell staff what's measured and that consistency beats bursts** — that's true, and it's also exactly the behaviour you want. Don't publish the exact targets.

---

## Why it doesn't auto-promote

You asked for stats-based auto-flagging, and that's what this is — it computes the score and tells you READY, BORDERLINE or BELOW BAR without you doing any thinking. What it stops short of is pulling the trigger.

A bot that auto-promotes will eventually promote whoever reverse-engineers the formula. And when someone gets promoted and then does something stupid, the answer to "who decided this" becomes "the bot did", which is not a thing a staff team survives twice. The card already does the work — clicking `/promote` costs five seconds and keeps a human name on every decision.

---

## Notes

- Everything lives in `data/staffbot.sqlite`. **Back it up.** It's one file; copying it is the backup. Losing it loses your entire staff history.
- Tracking only starts once someone is registered (`/trial start`, `/promote`, or `/sync`). Existing staff have no back-history — expected.
- To change the ladder, edit `config.ranks` and run `npm run deploy` again. Every command adapts to whatever list is there.
- `npm run check` (or `check.bat`) audits your config and tells you what is still missing.
- `npm test` runs 60+ offline checks. No Discord connection needed.

## Troubleshooting

**"Discord refused the role change: Missing Permissions"** — the bot's role is below your rank roles. Drag it up.

**The dropdown does nothing when someone picks an option** — the bot is not running, or it cannot create the channel. Check the console. The usual cause is a missing **Manage Channels** permission (re-run `npm run invite` and use the new link) or a `categoryId` that is not a category.

**Ticket metrics stay at 0** — with the native system, check `tickets.enabled` is true and that you have actually closed a ticket; credit is paid at close, not at open. Nobody is credited if no staff member claimed it *and* nobody cleared `minMessagesToCredit`. Still on Ticket King? Staffbot can't see inside the channels — add its role to Ticket King's support roles, or grant View Channel + Read Message History on the category, and check `ticketKing.categoryIds` points at the CATEGORY, not a channel.

**Closing a ticket loses the conversation** — `tickets.logChannelId` is not set, so there is nowhere to put the transcript. Set it, or set `deleteDelaySeconds: null` to keep the channels instead.

**`/ticket priority` says it could not rename the channel** — Discord limits channel renames to roughly twice per 10 minutes. The priority itself is saved; the name catches up next time.

**Mod actions always 0** — the bot needs **View Audit Log**. It also only sees actions taken while it's online, which matters when you're hosting on a PC.

**Message counts stay 0** — Message Content Intent is off in the developer portal.

**The dashboard will not load** — check the bot console for `[web] dashboard:`. If the port is taken it says so; change `web.port`. On a server, remember it only listens on loopback, so you need the SSH tunnel above.

**The dashboard says "Not signed in" every time you restart** — sessions live in memory, so a restart signs you out. Set `WEB_TOKEN` in `.env` and the token at least stops changing.

**A setting you changed on the website went back** — a value that is also set in `config.js` is only overridden while the entry exists in `data/config.local.json`. Deleting that file resets everything to the committed defaults.

**Commands don't appear** — run `npm run deploy` (or `setup.bat`) and check `GUILD_ID`. Guild commands appear instantly; if nothing shows, the ID is wrong.

**Buttons say "This interaction failed"** — the bot isn't running, or it crashed. Check the console window.

**`setup.bat` fails with a wall of `gyp ERR` / "Could not find any Visual Studio installation"** — npm tried to *compile* the database library instead of downloading a ready-made one, because your Node.js version is newer than the available prebuilt binaries. Easiest fix: uninstall Node and install **Node 22 LTS**, delete the `node_modules` folder, and run `setup.bat` again. (Alternatively install the [C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload so it can compile — but that is a multi-GB download for no benefit.)

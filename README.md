# Staffbot

Staff ranks, trial evaluation, and Ticket King integration for a Discord server.

- **`/promote` and `/demote`** move people along your ladder, with guardrails so nobody can touch someone at or above their own rank.
- **Ticket King integration** — Staffbot watches your Ticket King category and works out who actually handled each ticket.
- **`/trial start`** puts someone on the clock. The bot then measures what they actually do.
- At the end it posts a **scorecard** — objective numbers plus senior-staff vouches — flagged **READY / BORDERLINE / BELOW BAR**.

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

Your Owner / Founder / Co-Owner role IDs go in `permissions.overrideRoleIds` and bypass all of it, including each other.

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
- the **category** Ticket King creates its ticket channels in

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
| `/review user: [public:]` | Head Mod+ | Full scorecard, any time |
| `/vouch user: verdict: [reason:]` | Head Mod+ | Your yes/no/abstain on a trial member |
| `/note user: kind: note:` | Head Mod+ | Log something they did well or badly |
| `/staffstats user: [days:]` | Head Mod+ | Raw numbers over any window |
| `/conduct user: [lines:]` | Head Mod+ | Read a sample of what they've actually been saying |
| `/link set user: ign:` | Head Mod+ | Map a Minecraft username to a Discord account |
| `/link list` | Head Mod+ | Every link, and which staff are missing one |
| `/sync` | Head Mod+ | Register existing role-holders into the database |

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

## Tickets — Ticket King does the tickets

Staffbot has no ticket system of its own. **Ticket King** runs your tickets; Staffbot just watches so that ticket work still counts toward a trial's score.

It works by watching the **category** Ticket King creates its channels in — not by reading its embeds:

| What happens | What Staffbot records |
|---|---|
| A channel appears in the category | A ticket opened |
| First staff message in it | Response time for that person |
| Every staff message | A participation count |
| The channel disappears | Ticket closed — credit whoever did the work |

Because it only depends on channels appearing and disappearing, a Ticket King update that rewords their embeds cannot break it.

### Who gets the credit

1. **The claimer**, if Ticket King's `/claim` was detected. They owned it.
2. Otherwise **the staff member who sent the most messages**, provided they cleared `minMessagesToCredit` (default 3).
3. Otherwise **nobody**.

Note this is deliberately not "whoever closed it". Closing is one click and would be the easiest number in the whole system to farm. Doing the talking is not.

`creditEveryone: true` credits every staff member over the threshold instead of just the top one — reasonable if your team genuinely tag-teams tickets, inflationary if they don't.

### Setup

```js
ticketKing: {
  enabled: true,
  categoryIds: ['YOUR_TICKET_CATEGORY_ID'],
  botUserId: '710034409214181396',
  claimPattern: '...',
  minMessagesToCredit: 3,
  creditEveryone: false,
}
```

**Staffbot must be able to see inside ticket channels.** This is the one thing that needs checking in your server, because Ticket King's claim modes change channel permissions:

- Best: add Staffbot's role to Ticket King's **support roles** in their dashboard. That guarantees visibility under all four claim modes.
- Or: grant Staffbot's role **View Channel** and **Read Message History** on the ticket category, then open a test ticket, claim it, and confirm Staffbot can still see it.

If Staffbot can't see the channels, ticket metrics stay at zero and nothing tells you why — so test it once with a throwaway ticket before your first real trial.

### Claim detection

`claimPattern` is a regex matched against Ticket King's own messages in a ticket. The first capture group that looks like a user ID is taken as the claimer. The shipped pattern covers the usual phrasings ("X has claimed this ticket", "Claimed by X").

If it never matches, **nothing breaks** — credit quietly falls back to the message count. On startup Staffbot logs how many claims it has detected, so you'll know within a day whether it's working:

```
[tickets] watching 1 category · 3 tickets currently open · claims detected so far: 12
```

If that number stays at 0 while your team is definitely claiming, send me a screenshot of a Ticket King claim message and I'll rewrite the pattern.

### If the bot is offline

It runs on a PC, so it will miss events whenever that PC sleeps. On startup it reconciles: tickets that opened while it was away get registered, and tickets whose channel has since vanished get closed and credited from the message counts it did record. Long outages will under-count, which is worth knowing when reading a scorecard that spans one.

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

**Ticket metrics stay at 0** — Staffbot can't see inside the ticket channels. Add its role to Ticket King's support roles, or grant it View Channel + Read Message History on the ticket category. Check `ticketKing.categoryIds` points at the CATEGORY, not a channel.

**Mod actions always 0** — the bot needs **View Audit Log**. It also only sees actions taken while it's online, which matters when you're hosting on a PC.

**Message counts stay 0** — Message Content Intent is off in the developer portal.

**Commands don't appear** — run `npm run deploy` (or `setup.bat`) and check `GUILD_ID`. Guild commands appear instantly; if nothing shows, the ID is wrong.

**Buttons say "This interaction failed"** — the bot isn't running, or it crashed. Check the console window.

**`setup.bat` fails with a wall of `gyp ERR` / "Could not find any Visual Studio installation"** — npm tried to *compile* the database library instead of downloading a ready-made one, because your Node.js version is newer than the available prebuilt binaries. Easiest fix: uninstall Node and install **Node 22 LTS**, delete the `node_modules` folder, and run `setup.bat` again. (Alternatively install the [C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload so it can compile — but that is a multi-GB download for no benefit.)

# Hosting Staffbot on Render

## Read this first

Render's **free tier cannot run this bot properly**, and the reason isn't obvious:

| | Free | What it means here |
|---|---|---|
| Service types | Web services only — no background workers | A bot has to pretend to be a website |
| Inactivity | Spins down after **15 minutes** with no HTTP traffic | Bot goes offline; tracking stops |
| Persistent disk | **Not available** | **The SQLite database is wiped on every restart, redeploy and spin-down** |

That last row is the killer. Your entire staff history — ranks, trials, vouches, notes, metrics, Minecraft links — lives in one SQLite file. On a free Render instance that file is destroyed roughly every 15 minutes. The bot would appear to work and would quietly forget everything.

So there are two honest options.

---

## Option A — Paid worker + disk (recommended)

**$7.25/month.** A Starter background worker ($7) plus a 1 GB persistent disk ($0.25). No spin-down, no keep-alive hacks, database survives deploys, and the code needs no changes.

### 1. Put the code on GitHub

```bash
cd C:\Projects\staffbot
git init
git add .
git commit -m "Staffbot"
```

Make a **private** repo on GitHub, then follow its "push an existing repository" instructions.

> `.gitignore` already excludes `.env`, `data/` and `node_modules/`, so your token and database don't get pushed. Check that `.env` is genuinely absent from the repo before making it public — better still, keep it private.

### 2. Create the service

Render Dashboard → **New** → **Blueprint** → pick your repo. It reads `render.yaml` and sets up a background worker with a 1 GB disk mounted at `/var/data`.

If you'd rather click through manually: **New → Background Worker**, connect the repo, then set

- **Build command:** `npm ci && npm run deploy`
- **Start command:** `npm start`
- **Instance type:** Starter
- **Disk:** name `staffbot-data`, mount path `/var/data`, size 1 GB

### 3. Environment variables

In the service's **Environment** tab add:

| Key | Value |
|---|---|
| `DISCORD_TOKEN` | your bot token |
| `CLIENT_ID` | application ID |
| `GUILD_ID` | server ID |
| `DATA_DIR` | `/var/data` |
| `NODE_VERSION` | `22` |

`DATA_DIR` is the important one. Without it the database goes back to the ephemeral folder and you lose everything on the next deploy, disk or no disk.

### 4. Deploy and watch the logs

```
[db] using /var/data
[commands] loaded 9: demote, link, note, promote, review, staffstats, sync, trial, vouch
[ready] logged in as Quartermaster#8865
[perms] manage staff: Head Mod+ · vouch: Head Mod+ · review/link: Head Mod+ · 3 override role(s) bypass everything
[startup] 4 people can cast a /vouch (Head Mod+ and override roles) · 2 needed
[gamechat] bridge channel set · 0 name(s) linked · 5 staff member(s) with no Minecraft name
[tickets] watching 1 category · 0 tickets currently open · claims detected so far: 0
```

`[db] using /var/data` on the first line is the one to check. If it's missing, `DATA_DIR` isn't set.

### 5. Move your existing database across

If you've already been running locally and want to keep that history, the file is `data/staffbot.sqlite`. Render gives you a shell on paid instances (**Shell** tab) but no upload button, so the practical options are:

- Start fresh on Render and re-run `/sync` — fine if you've only been testing.
- Or paste the file in via the shell using base64 if the history matters. Ask me and I'll give you the exact commands.

---

## Option B — Genuinely free, but needs a code change

Free Render web service + an external free Postgres (Neon or Supabase, neither of which expires) + a free uptime pinger to stop the 15-minute spin-down.

This works, but it means **porting the database layer from SQLite to Postgres** — every query in `src/db.js`. It's a real change, not a config tweak. Render's own free Postgres doesn't help: it expires 30 days after creation.

Worth it if $7/month is the blocker. Ask and I'll do the port.

---

## Either way

**Re-registering commands.** The build command runs `npm run deploy`, so slash commands re-register on every deploy. Harmless and idempotent.

**Config changes need a redeploy.** `config.js` is read at startup and is part of the repo, so editing it means commit → push → Render redeploys. That's slower than editing a local file — worth knowing before you go hunting for a dashboard setting that doesn't exist.

**Back up the database.** Even on a persistent disk. Render's **Shell** tab:

```bash
cd /var/data && ls -la
```

Copy `staffbot.sqlite` somewhere safe now and then. It's one file and it's irreplaceable.

**The bot stays online.** No more "keep the window open" — that's the whole point. It also means tracking keeps running while your PC is off, so scores stop under-counting.

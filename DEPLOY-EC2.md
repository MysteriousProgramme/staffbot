# Hosting Staffbot on EC2

This is the best option you have. An EC2 instance is a real always-on Linux machine, so:

- **No code changes.** SQLite works exactly as it does on your PC.
- **No spin-down**, no keep-alive pinger, no external database.
- **No inbound ports.** The bot only makes outbound connections to Discord, so you don't touch the security group at all.
- Free for 12 months on the AWS free tier, and cheap after.

Prebuilt binaries exist for both x86 (`t2.micro`, `t3.micro`) and ARM (`t4g`), so nothing needs compiling either way.

---

## 1. Connect

```bash
ssh -i your-key.pem ec2-user@YOUR-INSTANCE-IP     # Amazon Linux
ssh -i your-key.pem ubuntu@YOUR-INSTANCE-IP       # Ubuntu
```

If you get `UNPROTECTED PRIVATE KEY FILE`, run `chmod 400 your-key.pem` first.

## 2. Get the code onto the box

Since it's already on GitHub:

```bash
sudo dnf install -y git     # Amazon Linux    (Ubuntu: sudo apt install -y git)
git clone https://github.com/MysteriousProgramme/staffbot.git
cd staffbot
```

A private repo will ask for credentials — use a **personal access token** as the password (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained → read-only on this repo).

Or skip Git entirely and copy from your PC:

```powershell
scp -i your-key.pem -r C:\Projects\staffbot ec2-user@YOUR-IP:~/
```

If you do that, delete `node_modules` from your PC copy first — thousands of files you'd be uploading for no reason, and they'd be the wrong architecture anyway.

## 3. Create `.env`

```bash
nano .env
```

Three lines, no quotes, no spaces around the `=`:

```
DISCORD_TOKEN=your_token
CLIENT_ID=1540061591968555059
GUILD_ID=1503453274223673485
```

`Ctrl+O`, `Enter`, `Ctrl+X` to save and quit.

## 4. Run the installer

```bash
bash deploy/install.sh
```

It installs Node 22, installs dependencies, checks your config, registers the slash commands, and sets the bot up as a **systemd service** — meaning it starts on boot and restarts itself if it crashes.

Expect to end on something like:

```
[db] using .../data
[commands] loaded 18: adjustments, conduct, coverage, deduct, demote, digest, increase, leaderboard, link, loa, note, promote, promotions, review, staffstats, sync, trial, vouch
[ready] logged in as Quartermaster#8865
[perms] manage staff: Head Mod+ · vouch: Head Mod+ · review/link: Head Mod+ · 3 override role(s) bypass everything
[startup] 4 people can cast a /vouch (Head Mod+ and override roles) · 2 needed
```

## 5. Then in Discord

```
/sync                    register your existing staff
/link set user:@… ign:…  once per staff member
```

---

## Running it day to day

| | |
|---|---|
| `sudo systemctl status staffbot` | Is it running? |
| `journalctl -u staffbot -f` | Live logs — your `start.bat` window equivalent |
| `journalctl -u staffbot --since "1 hour ago"` | What happened earlier |
| `sudo systemctl restart staffbot` | After editing `config.js` |
| `sudo systemctl stop staffbot` | Take it offline |

### Updating to a new version

Push the new code from your PC, then on the server:

```bash
cd ~/staffbot && bash deploy/update.sh
```

That pulls, reinstalls dependencies, checks the config, **re-registers the slash commands** and restarts. The command registration is the step people forget — new commands simply won't appear in Discord without it.

### Just changing config

```bash
cd ~/staffbot
nano config.js
sudo systemctl restart staffbot
```

Or if you edited it on GitHub in the browser:

```bash
cd ~/staffbot && git pull && sudo systemctl restart staffbot
```

### Back up the database

The database is the only irreplaceable thing on the box. Set a daily backup:

```bash
crontab -e
```

Add:

```
0 4 * * * /home/ec2-user/staffbot/deploy/backup.sh
```

That keeps 14 days of snapshots in `~/staffbot/backups/`. It uses SQLite's `.backup` rather than `cp` — copying a live WAL database with `cp` can produce a corrupt file, which you'd only discover when you needed it.

To pull one down to your PC:

```powershell
scp -i your-key.pem ec2-user@YOUR-IP:~/staffbot/backups/staffbot-2026-08-25.sqlite .
```

---

## Things worth knowing

**Free tier runs out after 12 months.** A `t3.micro` is roughly $7–8/month after that — same ballpark as Render, but on a machine you control. Set a billing alarm now rather than finding out in a year.

**If the instance is already running something else**, this is fine alongside it. The bot uses very little — a few hundred MB of RAM and almost no CPU. Just don't put it on a box you might tear down.

**`.env` permissions.** The installer runs `chmod 600 .env` so only your user can read it. Worth keeping that way.

**Timezone.** The coverage bar on review cards is UTC. If your team thinks in another timezone, mentally shift it, or tell me and I'll make it configurable.

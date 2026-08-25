const fs = require('fs');
const path = require('path');

// ---- credentials ----
// Locally these come from a .env file. On a host like Render they are set in
// the dashboard and already present in process.env, so the .env file must be
// optional — requiring it would make the bot refuse to start in production.
const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
} else if (!process.env.DISCORD_TOKEN) {
  // No file AND nothing in the environment: this is a local setup mistake.
  const example = path.join(ROOT, '.env.example');
  let hint = '';
  if (fs.existsSync(example)) {
    const body = fs.readFileSync(example, 'utf8');
    if (!/your_bot_token_here/.test(body) && /DISCORD_TOKEN=\S{20,}/.test(body)) {
      hint =
        '\n   It looks like you filled in .env.example instead. That file is only a template —\n' +
        '   the bot never reads it. Save a copy named exactly ".env" in the same folder.\n' +
        '\n   Since that token has been sitting in a template file, reset it in the Developer\n' +
        '   Portal (Bot > Reset Token) and put the NEW one in .env.';
    }
  }
  console.error(
    `\n  No .env file, and no DISCORD_TOKEN in the environment.\n${hint}\n\n` +
      '   Running locally? The file must be named ".env" exactly — not ".env.txt",\n' +
      '   not ".env.example". Turn on View > File name extensions in Explorer.\n' +
      '   Hosting? Set DISCORD_TOKEN, CLIENT_ID and GUILD_ID in your host\'s\n' +
      '   environment variables instead.\n'
  );
  process.exit(1);
}

if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN.startsWith('your_')) {
  console.error('\n  DISCORD_TOKEN is missing or still the placeholder.\n');
  process.exit(1);
}

const {
  Client,
  Collection,
  GatewayIntentBits,
  Events,
  MessageFlags,
} = require('discord.js');

const config = require('../config');
const tracking = require('./tracking');
const ticketWatch = require('./ticketWatch');
const gameChat = require('./gameChat');
const trialScheduler = require('./trialScheduler');
const startupChecks = require('./startupChecks');
const observe = require('./observe');

// ---- sanity check the config before we waste time connecting ----
function validateConfig() {
  const problems = [];
  // Real Discord snowflakes are 15-20 digits and never start with 0, so a
  // leading zero means it's still one of the placeholders shipped in config.js.
  const placeholder = (id) =>
    !id || String(id).startsWith('0') || !/^\d{15,20}$/.test(String(id));

  if (!config.ranks.length) problems.push('config.ranks is empty.');
  config.ranks.forEach((r, i) => {
    if (placeholder(r.roleId)) problems.push(`ranks[${i}] (${r.name}) still has a placeholder roleId.`);
  });
  if (placeholder(config.channels.reviews)) problems.push('channels.reviews is not set.');
  if (config.gameChat?.enabled && placeholder(config.gameChat.channelId)) {
    problems.push(
      'gameChat.enabled is true but gameChat.channelId is not set — in-game presence will not be scored.'
    );
  }
  if (config.ticketKing?.enabled) {
    const cats = config.ticketKing.categoryIds ?? [];
    if (!cats.length || cats.every(placeholder)) {
      problems.push('ticketKing.categoryIds has no real category ID — ticket work will not be tracked.');
    }
  }

  // Only these permission settings name a rank. Everything else in that block
  // (overrideRoleIds, trackOverrides) is a different kind of setting.
  const keys = config.ranks.map((r) => r.key);
  for (const name of ['manageStaff', 'vouch', 'review']) {
    const key = config.permissions[name];
    if (!keys.includes(key)) problems.push(`permissions.${name} = "${key}" is not a rank key.`);
  }

  if (problems.length) {
    console.error('\n  Config problems — fix these in config.js before the bot will work:\n');
    for (const p of problems) console.error('   • ' + p);
    console.error('');
    if (problems.some((p) => p.includes('ranks[') || p.includes('is not a rank key'))) {
      process.exit(1);
    }
  }
}
validateConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
});

// ---- load commands ----
client.commands = new Collection();
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (command?.data && command?.execute) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`[commands] ${file} is missing data or execute — skipped.`);
  }
}
console.log(`[commands] loaded ${client.commands.size}: ${[...client.commands.keys()].join(', ')}`);

// ---- interactions ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (!interaction.inGuild()) {
    return interaction.reply({
      content: 'These commands only work inside the server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`[commands] ${interaction.commandName} threw:`, error);
    const payload = {
      content: 'Something went wrong running that. The error is in the bot console.',
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

tracking.register(client);
ticketWatch.register(client);

client.once(Events.ClientReady, (c) => {
  console.log(`[ready] logged in as ${c.user.tag}`);
  startupChecks.describePermissions();
  trialScheduler.start(c);
  gameChat.report(c);
  observe.startPurge();
  startupChecks.run(c).catch((e) => console.error('[startup]', e));
});

// Some hosts (Render web services, for one) kill anything that doesn't bind a
// port, and only keep a free instance awake while it receives HTTP traffic.
// Deployed as a background worker there is no PORT and none of this runs.
if (process.env.PORT) {
  const http = require('http');
  http
    .createServer((req, res) => {
      const up = client.isReady();
      res.writeHead(up ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: up ? 'ok' : 'starting',
          bot: client.user?.tag ?? null,
          uptimeSeconds: Math.round(process.uptime()),
        })
      );
    })
    .listen(process.env.PORT, () =>
      console.log(`[health] listening on :${process.env.PORT}`)
    );
}

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  if (e?.code === 'TokenInvalid') {
    console.error(
      '\n  Discord rejected the token.\n\n' +
        '   Tokens are shown once, and are invalidated the moment they are regenerated,\n' +
        '   posted, or committed anywhere. Go to the Developer Portal > your app > Bot >\n' +
        '   Reset Token, copy the new one, and paste it into .env as:\n\n' +
        '       DISCORD_TOKEN=the_new_token\n\n' +
        '   No quotes, no spaces around the "=", all on one line.\n'
    );
  } else if (e?.code === 'DisallowedIntents') {
    console.error(
      '\n  Discord refused the requested intents.\n\n' +
        '   Developer Portal > your app > Bot, and switch ON all three\n' +
        '   Privileged Gateway Intents (Server Members, Message Content, Presence).\n'
    );
  } else {
    console.error('\n  Could not log in:', e?.message ?? e, '\n');
  }
  process.exit(1);
});

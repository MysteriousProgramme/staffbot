require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

// Everything the bot needs: view/send/embed/attach/history, manage messages,
// manage roles (promotions), view audit log (mod actions).
const PERMS = '268561536';
const inviteUrl = (id) =>
  `https://discord.com/oauth2/authorize?client_id=${id}&permissions=${PERMS}&scope=bot%20applications.commands`;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error(
    '\n  Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID.\n\n' +
      '   The file must be named ".env" exactly — filling in .env.example does nothing,\n' +
      '   it is only a template. Save a copy named .env in the project folder.\n'
  );
  process.exit(1);
}

const commands = [];
const dir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(dir, file));
  if (command?.data) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(`\n  Registering ${commands.length} commands to server ${GUILD_ID}...\n`);
    const data = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log(`  Done. ${data.length} commands are live:`);
    console.log(`  ${data.map((c) => '/' + c.name).join('  ')}\n`);
    console.log('  They appear in Discord immediately. If you still cannot see them,');
    console.log('  press Ctrl+R in Discord to reload the client.\n');
  } catch (error) {
    const status = error?.status;
    const code = error?.rawError?.code ?? error?.code;

    console.error('\n  ============================================');
    console.error('   Could not register the commands.');
    console.error('  ============================================\n');

    if (status === 401 || code === 0 || code === 50014) {
      console.error('  Discord rejected the token (401 Unauthorized).\n');
      console.error('   Reset it: Developer Portal > your app > Bot > Reset Token,');
      console.error('   then paste the new value into .env as DISCORD_TOKEN=...');
      console.error('   No quotes, no spaces around the "=", all on one line.\n');
    } else if (code === 50001) {
      console.error('  Missing Access (50001).\n');
      console.error('   The bot is in your server, but it was invited WITHOUT the');
      console.error('   "applications.commands" scope — so it is not allowed to add');
      console.error('   slash commands there. This is the usual cause.\n');
      console.error('   Re-invite it with the correct scopes using this exact link:\n');
      console.error(`   ${inviteUrl(CLIENT_ID)}\n`);
      console.error('   Picking the same server again just adds the missing scope —');
      console.error('   it will not kick the bot or reset anything.\n');
    } else if (code === 10004) {
      console.error('  Unknown Guild (10004).\n');
      console.error('   Either GUILD_ID in .env is wrong, or the bot is not in that server.');
      console.error(`   Your .env currently says GUILD_ID=${GUILD_ID}\n`);
      console.error('   Right-click your server name in Discord > Copy Server ID and compare.');
      console.error('   If the bot is genuinely not in the server, invite it:\n');
      console.error(`   ${inviteUrl(CLIENT_ID)}\n`);
    } else if (code === 10002) {
      console.error('  Unknown Application (10002).\n');
      console.error(`   CLIENT_ID=${CLIENT_ID} is not a valid application ID.`);
      console.error('   Copy it from Developer Portal > your app > General Information.\n');
    } else if (status === 429) {
      console.error('  Rate limited. Wait a minute and run this again.\n');
    } else if (status === 403) {
      console.error('  Discord returned 403 Forbidden.\n');
      console.error('   Most likely the bot was invited without the "applications.commands"');
      console.error('   scope, so it may not add slash commands to your server.\n');
      console.error('   Re-invite it with this link (safe on a server it is already in):\n');
      console.error(`   ${inviteUrl(CLIENT_ID)}\n`);
      console.error('   If that does not fix it, a VPN, proxy or firewall may be blocking');
      console.error('   Discord\'s API from this machine — try again with it turned off.\n');
    } else {
      console.error(`  ${error?.message ?? error}\n`);
      if (error?.rawError) console.error(JSON.stringify(error.rawError, null, 2), '\n');
    }
    process.exit(1);
  }
})();

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const PERMS = '268561536';
const id = process.env.CLIENT_ID;

if (!id) {
  console.error('\n  CLIENT_ID is not set in .env.\n');
  process.exit(1);
}

console.log('\n  Invite / re-invite link for this bot:\n');
console.log(
  `  https://discord.com/oauth2/authorize?client_id=${id}&permissions=${PERMS}&scope=bot%20applications.commands\n`
);
console.log('  This grants: View Channels, Send Messages, Embed Links, Attach Files,');
console.log('  Read Message History, Manage Messages, Manage Roles,');
console.log('  View Audit Log — plus the applications.commands scope that slash');
console.log('  commands require.\n');
console.log('  Re-using it on a server the bot is already in is safe: it tops up the');
console.log('  missing scopes and permissions without removing the bot.\n');
console.log('  Afterwards, drag the bot\'s role ABOVE your five rank roles in');
console.log('  Server Settings > Roles, or promotions will fail.\n');

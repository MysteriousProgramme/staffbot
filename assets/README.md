# assets

Images the bot uploads with its own messages.

Referenced from `config.js` by **filename only** — for example the tournament panel
uses `thumbnailFile: 'tournament_participant.png'`, which is this folder plus that
name. Drop a file in, run `/application open`, and it appears; no restart needed.

These are committed to git on purpose. That is how they reach the server: `git pull`
on EC2 brings them along with the code, so there is nothing separate to upload and no
way for the config to name a file the server does not have.

The panel re-uploads its image every time it is edited. `attachment://` resolves only
against a file attached to the same message, so a panel that changed from OPEN to
CLOSED without re-sending the file would keep the embed and lose the picture.

Keep them small. Discord caps an attachment at 10MB without a boost, and this one is
sent again on every open and close.

'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'ban',
  description: 'Ban a Minecraft account from the server.',
  action: 'ban',
  duration: true,
  reason: 'required',
  destructive: true,
});

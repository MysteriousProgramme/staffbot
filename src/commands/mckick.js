'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'kick',
  description: 'Disconnect a Minecraft account now.',
  action: 'kick',
  duration: false,
  reason: 'required',
  destructive: false,
});

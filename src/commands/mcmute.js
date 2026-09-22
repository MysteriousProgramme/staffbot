'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'mute',
  description: 'Stop a Minecraft account talking in chat.',
  action: 'mute',
  duration: true,
  reason: 'required',
  destructive: false,
});

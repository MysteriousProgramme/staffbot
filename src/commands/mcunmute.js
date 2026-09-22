'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'unmute',
  description: 'Lift a mute.',
  action: 'unmute',
  duration: false,
  reason: 'optional',
  destructive: false,
});

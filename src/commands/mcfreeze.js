'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'freeze',
  description: 'Freeze a player in place. They must be online.',
  action: 'freeze',
  duration: false,
  reason: 'optional',
  destructive: false,
});

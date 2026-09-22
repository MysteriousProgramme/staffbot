'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'unban',
  description: 'Lift a ban.',
  action: 'unban',
  duration: false,
  reason: 'optional',
  destructive: false,
});

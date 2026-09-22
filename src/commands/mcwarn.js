'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'warn',
  description: 'Record a warning against a Minecraft account. No in-world effect.',
  action: 'warn',
  duration: false,
  reason: 'required',
  destructive: false,
});

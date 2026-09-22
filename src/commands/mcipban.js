'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'ipban',
  description: 'Ban the address a Minecraft account last connected from.',
  action: 'ipban',
  duration: true,
  reason: 'required',
  destructive: true,
});

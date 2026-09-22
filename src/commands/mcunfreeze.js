'use strict';

// Thin wrapper. All of the behaviour lives in ../modCommand.js, and all of the rules
// live in the Minecraft plugin — this file only declares the command's shape.

module.exports = require('../modCommand').build({
  name: 'unfreeze',
  description: 'Release a frozen player.',
  action: 'unfreeze',
  duration: false,
  reason: 'none',
  destructive: false,
});

// Preserve the release-pinned JSON bytes: tsc otherwise reformats JSON assets.
const { copyFileSync } = require('node:fs');
const { resolve } = require('node:path');
copyFileSync(resolve(__dirname, '../src/flp/idl/flp_vault_v4.json'), resolve(__dirname, '../dist/flp/idl/flp_vault_v4.json'));

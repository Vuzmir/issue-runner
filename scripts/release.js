#!/usr/bin/env node
'use strict';

const { execSync } = require('node:child_process');

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function head() {
  return execSync('git rev-parse HEAD').toString().trim();
}

try {
  console.log('[release] typecheck + test...');
  run('npm run typecheck');
  run('npm run test');
} catch {
  console.error('\n[release] verification failed - nothing was pushed. Fix the errors above and try again.');
  process.exit(1);
}

try {
  console.log('[release] pushing main...');
  run('git push origin main');
} catch {
  console.error('\n[release] push failed - v1 and v1.0.0 were left untouched.');
  process.exit(1);
}

// Read HEAD only after main is safely on origin: the tags must never point at a commit the
// remote does not have yet, or pushing them fails.
try {
  const sha = head();
  console.log(`[release] moving v1 and v1.0.0 to ${sha}...`);
  run(`git tag -f v1.0.0 ${sha}`);
  run(`git tag -f v1 ${sha}`);
  run('git push origin v1.0.0 v1 --force');
} catch {
  console.error(
    '\n[release] main pushed, but moving the tags failed - v1 and v1.0.0 no longer match ' +
      'main. Move and push them by hand: git tag -f v1.0.0 && git tag -f v1 && ' +
      'git push origin v1.0.0 v1 --force',
  );
  process.exit(1);
}

console.log('[release] done: main, v1 and v1.0.0 all point at the same commit.');

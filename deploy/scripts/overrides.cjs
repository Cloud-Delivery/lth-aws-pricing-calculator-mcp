const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function applyOverrides(staging, overrides) {
  const manifest = JSON.parse(await fs.readFile(path.join(overrides, 'manifest.json'), 'utf8'));
  for (const [relative, expected] of Object.entries(manifest)) {
    if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(relative)
      || relative === '.' || relative === '..' || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`Invalid override manifest entry: ${relative}`);
    }
    const target = path.join(staging, relative);
    const original = await fs.readFile(target, 'utf8');
    const actual = createHash('sha256').update(original.replace(/\r\n/g, '\n')).digest('hex');
    if (actual !== expected) {
      throw new Error(`Upstream changed: ${relative}. Review the override before updating its baseline hash.`);
    }
    await fs.copyFile(path.join(overrides, relative), target);
  }
  return Object.keys(manifest);
}

module.exports = { applyOverrides };

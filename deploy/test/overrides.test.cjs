const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { applyOverrides } = require('../scripts/overrides.cjs');

test('packaging applies the override without modifying the pinned upstream', async () => {
  const upstream = path.resolve(__dirname, '../../sample-aws-pricing-calculator-mcp');
  const manifest = require('../overrides/manifest.json');
  for (const [relative, expected] of Object.entries(manifest)) {
    const original = await fs.readFile(path.join(upstream, relative), 'utf8');
    assert.equal(createHash('sha256').update(original.replace(/\r\n/g, '\n')).digest('hex'), expected);
    assert.equal(await fs.readFile(path.resolve(__dirname, '../.staging', relative), 'utf8'),
      await fs.readFile(path.resolve(__dirname, '../overrides', relative), 'utf8'));
  }
  const { createEstimateStore } = require('../.staging/lib/store/estimate-store');
  const { DynamoEstimateStore } = require('../.staging/lib/store/estimate-store-dynamodb');
  assert.ok(createEstimateStore({ ESTIMATES_STORE: 'dynamodb', ESTIMATES_TABLE: 'test' })
    instanceof DynamoEstimateStore);
  assert.equal(execFileSync('git', ['-C', upstream, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('memory store behavior remains unchanged', () => {
  execFileSync(process.execPath, ['--test',
    path.resolve(__dirname, '../../sample-aws-pricing-calculator-mcp/test/estimate-store.test.js')], {
    env: { ...process.env, NODE_PATH: path.resolve(__dirname, '../node_modules') },
    stdio: 'pipe',
  });
});

test('override guard rejects upstream changes and accepts CRLF without changing source', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lth-overrides-'));
  const staging = path.join(temp, 'staging');
  const overrides = path.join(temp, 'overrides');
  try {
    await fs.mkdir(staging);
    await fs.mkdir(overrides);
    const baseline = 'original\n';
    await fs.writeFile(path.join(overrides, 'manifest.json'), JSON.stringify({
      'store.js': createHash('sha256').update(baseline).digest('hex'),
    }));
    await fs.writeFile(path.join(overrides, 'store.js'), 'replacement\n');
    await fs.writeFile(path.join(staging, 'store.js'), 'upgraded\n');
    await assert.rejects(applyOverrides(staging, overrides), /Upstream changed: store.js/);
    assert.equal(await fs.readFile(path.join(staging, 'store.js'), 'utf8'), 'upgraded\n');
    await fs.writeFile(path.join(staging, 'store.js'), 'original\r\n');
    assert.deepEqual(await applyOverrides(staging, overrides), ['store.js']);
    assert.equal(await fs.readFile(path.join(staging, 'store.js'), 'utf8'), 'replacement\n');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

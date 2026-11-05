const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { LocalServer } = require('../build/runtime/server');
const { createHandler } = require('../build/runtime/handler');
const fixture = require('./fixtures/rest-event.json');

test('packaged server handshakes, filters tools, reuses process and supports 405 without external writes', async () => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const previousStore = process.env.ESTIMATES_STORE;
  process.env.ESTIMATES_STORE = 'memory';
  const entry = path.resolve(__dirname, '../artifact/server/mcp-server.cjs');
  const server = new LocalServer(entry, port);
  const log = [];
  const handler = createHandler(server, 25000, item => log.push(item));
  async function call(payload, method = 'POST') {
    return handler({ ...structuredClone(fixture), httpMethod: method,
      body: payload === null ? null : JSON.stringify(payload) },
    { getRemainingTimeInMillis: () => 28000, callbackWaitsForEmptyEventLoop: true });
  }
  function envelope(response) {
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.headers['content-type'].startsWith('text/event-stream'));
    const data = response.body.split('\n').find(line => line.startsWith('data:'));
    assert.ok(data);
    const value = JSON.parse(data.slice(5));
    assert.equal(value.error, undefined);
    return value;
  }
  try {
    assert.ok(fs.readdirSync(path.join(path.dirname(entry), 'catalog/services')).length > 0);
    const result = envelope(await call({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'deployment-package-test', version: '1.0' } } }));
    assert.equal(result.id, 1);
    const notify = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notify.statusCode, 202);
    assert.equal(notify.body, '');
    for (let i = 0; i < 2; i++) {
      const listed = envelope(await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
      assert.equal(listed.result.tools.length, 9);
      assert.ok(!listed.result.tools.some(tool => tool.name === 'get_estimate_cost'));
    }
    const info = envelope(await call({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_server_info', arguments: {} } }));
    assert.equal(JSON.parse(info.result.content[0].text).tools.length, 9);
    const create = envelope(await call({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'create_estimate', arguments: { name: 'local-fixture' } } }));
    assert.ok(JSON.parse(create.result.content[0].text).estimate_id);
    assert.equal((await call({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'get_estimate_cost', arguments: {} } })).statusCode, 200);
    for (const method of ['GET', 'DELETE']) assert.equal((await call(null, method)).statusCode, 405);
    assert.deepEqual(log, [{ code: 'blocked-tool', requestId: 'fixture-request' }]);
  } finally {
    await server.stop();
    if (previousStore === undefined) delete process.env.ESTIMATES_STORE;
    else process.env.ESTIMATES_STORE = previousStore;
  }
});

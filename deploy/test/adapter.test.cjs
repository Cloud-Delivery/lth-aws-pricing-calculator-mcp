const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../build/runtime/handler');
const { filterResponse } = require('../build/runtime/protocol');
const fixture = require('./fixtures/rest-event.json');

function event(payload, overrides = {}) {
  return { ...structuredClone(fixture), body: JSON.stringify(payload), ...overrides };
}
function context() {
  return { getRemainingTimeInMillis: () => 28000, callbackWaitsForEmptyEventLoop: true };
}
function stub(response = { status: 200, headers: { 'content-type': 'application/json' },
  body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}' }) {
  return { calls: [], stopped: 0,
    async forward(...args) { this.calls.push(args); return structuredClone(response); },
    async stop() { this.stopped++; } };
}

test('REST fixture forwards protocol headers, never credentials or query parameters', async () => {
  const upstream = stub();
  const logs = [];
  const handler = createHandler(upstream, 25000, entry => logs.push(entry));
  const input = event({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
    headers: { ...fixture.headers, 'x-api-key': 'fixture-credential', Authorization: 'fixture-auth',
      'Content-Length': '9999', 'Mcp-Session-Id': 'fixture-session' },
    queryStringParameters: { 'x-api-key': 'fixture-query' },
  });
  const ctx = context();
  const output = await handler(input, ctx);
  assert.equal(ctx.callbackWaitsForEmptyEventLoop, false);
  assert.equal(output.statusCode, 200);
  assert.equal(upstream.calls[0][0], 'POST');
  assert.deepEqual(upstream.calls[0][1], {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    'mcp-protocol-version': '2025-03-26', 'mcp-session-id': 'fixture-session',
  });
  assert.equal(upstream.calls[0][2], input.body);
  assert.deepEqual(logs, []);
  assert.ok(!JSON.stringify(output).includes('fixture-credential'));
});

test('Chromium is filtered from JSON, SSE and get_server_info responses', () => {
  const list = { jsonrpc: '2.0', id: 1, result: { tools: [
    { name: 'get_estimate_cost' }, { name: 'get_server_info' }, { name: 'unknown' },
  ] } };
  const json = JSON.parse(filterResponse(JSON.stringify(list), 'application/json', 'tools/list'));
  assert.deepEqual(json.result.tools, [{ name: 'get_server_info' }]);
  const sse = filterResponse(`event: message\r\ndata: ${JSON.stringify(list)}\r\n\r\n`,
    'text/event-stream', 'tools/list');
  assert.ok(sse.startsWith('event: message\n'));
  assert.ok(sse.endsWith('\n\n'));
  assert.ok(!sse.includes('get_estimate_cost'));
  const info = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text',
    text: JSON.stringify({ tools: ['get_estimate_cost', 'get_server_info'] }) }] } };
  const output = JSON.parse(filterResponse(JSON.stringify(info), 'application/json', 'tools/call', 'get_server_info'));
  assert.deepEqual(JSON.parse(output.result.content[0].text).tools, ['get_server_info']);
});

test('blocked direct tool calls are explicit and do not launch the child', async () => {
  const upstream = stub();
  const logs = [];
  const handler = createHandler(upstream, 25000, entry => logs.push(entry));
  const output = await handler(event({ jsonrpc: '2.0', id: 'call', method: 'tools/call',
    params: { name: 'get_estimate_cost' } }), context());
  assert.equal(output.statusCode, 200);
  assert.equal(JSON.parse(output.body).error.code, -32602);
  assert.equal(JSON.parse(output.body).id, 'call');
  assert.equal(upstream.calls.length, 0);
  assert.deepEqual(logs, [{ code: 'blocked-tool', requestId: 'fixture-request' }]);
});

test('base64 REST body and singleton multi-value protocol headers are supported', async () => {
  const upstream = stub();
  const payload = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  await createHandler(upstream)(event(payload, {
    body: Buffer.from(JSON.stringify(payload)).toString('base64'), isBase64Encoded: true,
    multiValueHeaders: { 'MCP-Protocol-Version': ['2025-03-26'] },
  }), context());
  assert.equal(upstream.calls[0][2], JSON.stringify(payload));
});

test('malformed input and duplicate protocol headers return errors and operational logs', async () => {
  const upstream = stub();
  const logs = [];
  const handler = createHandler(upstream, 25000, entry => logs.push(entry));
  for (const input of [
    event({}, { body: 'broken' }),
    event([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
    event({ jsonrpc: '2.0', method: 'tools/list' }, {
      multiValueHeaders: { Accept: ['a', 'b'] },
    }),
    event({ jsonrpc: '2.0', method: 'tools/list' }, { resource: '/other' }),
    event({ jsonrpc: '2.0', method: 'tools/list' }, { httpMethod: 'PUT' }),
    event({ jsonrpc: '2.0', method: 'tools/list' }, { headers: {} }),
  ]) {
    const output = await handler(input, context());
    assert.ok(output.statusCode >= 400);
    assert.ok(JSON.parse(output.body).error);
  }
  assert.equal(logs.length, 6);
  assert.equal(upstream.calls.length, 0);
});

test('deadline aborts forwarding, waits for child termination and returns an explicit error', async () => {
  let stopped = false;
  const upstream = {
    forward(_method, _headers, _body, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('sensitive payload')), { once: true });
      });
    },
    async stop() { await new Promise(resolve => setTimeout(resolve, 10)); stopped = true; },
  };
  const logs = [];
  const start = Date.now();
  const output = await createHandler(upstream, 30, entry => logs.push(entry))(
    event({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), context());
  assert.equal(output.statusCode, 504);
  assert.equal(stopped, true);
  assert.ok(Date.now() - start >= 30);
  assert.ok(Date.now() - start < 2000);
  assert.equal(JSON.parse(output.body).id, 2);
  assert.ok(!JSON.stringify({ output, logs }).includes('sensitive payload'));
});

test('upstream errors are surfaced without logging sensitive exceptions', async () => {
  const upstream = stub();
  upstream.forward = async () => { throw new Error('sensitive-estimate-and-token'); };
  const logs = [];
  const output = await createHandler(upstream, 100, entry => logs.push(entry))(
    event({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), context());
  assert.equal(output.statusCode, 502);
  assert.equal(upstream.stopped, 1);
  assert.ok(!JSON.stringify({ output, logs }).includes('sensitive-estimate-and-token'));
});

test('initialized notification and GET/DELETE statuses are preserved', async () => {
  const upstream = stub({ status: 202, headers: {}, body: '' });
  const handler = createHandler(upstream);
  const output = await handler(event({ jsonrpc: '2.0', method: 'notifications/initialized' }), context());
  assert.equal(output.statusCode, 202);
  assert.equal(output.body, '');
  upstream.forward = async () => ({ status: 405, headers: { 'content-type': 'text/plain' },
    body: 'Method Not Allowed' });
  for (const method of ['GET', 'DELETE']) {
    const result = await handler(event(null, { httpMethod: method, body: null }), context());
    assert.equal(result.statusCode, 405);
  }
});

test('oversized proxy response is rejected and the child is stopped', async () => {
  const upstream = stub({ status: 200, headers: {}, body: '\u0000'.repeat(1024 * 1024) });
  const output = await createHandler(upstream, 100, () => {})(
    event({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), context());
  assert.equal(output.statusCode, 502);
  assert.equal(upstream.stopped, 1);
});

test('concurrent invocation is rejected instead of reattaching singleton transport', async () => {
  let release;
  const upstream = stub();
  upstream.forward = () => new Promise(resolve => { release = resolve; });
  const handler = createHandler(upstream, 1000, () => {});
  const first = handler(event({ jsonrpc: '2.0', id: 1, method: 'initialize' }), context());
  const second = await handler(event({ jsonrpc: '2.0', id: 2, method: 'initialize' }), context());
  assert.equal(second.statusCode, 503);
  release({ status: 200, headers: {}, body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
  assert.equal((await first).statusCode, 200);
});

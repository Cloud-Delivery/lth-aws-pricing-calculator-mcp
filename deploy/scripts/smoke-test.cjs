const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const profile = 'lutechlab-sandbox';
const region = 'eu-south-1';
function aws(...args) {
  const output = execFileSync('aws', [...args, '--profile', profile, '--region', region,
    '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(output);
}

async function main() {
  assert.equal(aws('sts', 'get-caller-identity').Account, '695076071513', 'Unexpected AWS account');
  const stack = aws('cloudformation', 'describe-stacks', '--stack-name', 'LthAwsPricingMcpStack').Stacks[0];
  assert.ok(['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus), 'Stack not ready');
  const outputs = Object.fromEntries(stack.Outputs.map(o => [o.OutputKey, o.OutputValue]));
  const url = new URL(outputs.ApiUrl);
  assert.equal(url.protocol, 'https:');
  assert.match(url.hostname, /^[a-z0-9]+\.execute-api\.eu-south-1\.amazonaws\.com$/);
  assert.equal(url.pathname, '/sandbox/mcp');
  let key = aws('apigateway', 'get-api-key', '--api-key', outputs.ApiKeyId, '--include-value');
  assert.equal(key.enabled, true, 'API key is disabled');
  assert.ok(typeof key.value === 'string' && key.value.length > 0, 'API key value missing');
  let version = '2025-03-26';
  let id = 0;
  const evidence = [];
  async function request(label, method, payload, credential, expectedStatus) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const headers = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': version };
    if (credential !== undefined) headers['x-api-key'] = credential;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const start = performance.now();
    const response = await fetch(url, { method, headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(35000) });
    const body = await response.text();
    const row = { check: label, status: response.status, contentType: response.headers.get('content-type'),
      requestId: response.headers.get('x-amzn-requestid'), durationMs: Math.round(performance.now() - start) };
    evidence.push(row);
    console.log(JSON.stringify(row));
    assert.equal(response.status, expectedStatus, `${label}: unexpected HTTP status`);
    return { body, response };
  }
  async function rpc(method, params) {
    const rpcId = ++id;
    const { body, response } = await request(method, 'POST',
      { jsonrpc: '2.0', id: rpcId, method, params }, key.value, 200);
    const type = response.headers.get('content-type') || '';
    assert.ok(type.startsWith('text/event-stream') || type.startsWith('application/json'), 'Unexpected MCP content type');
    const data = type.startsWith('text/event-stream')
      ? body.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5) : body;
    assert.ok(data, 'Missing JSON-RPC response');
    const envelope = JSON.parse(data);
    assert.equal(envelope.jsonrpc, '2.0');
    assert.equal(envelope.id, rpcId);
    assert.equal(envelope.error, undefined, 'JSON-RPC error returned');
    assert.ok(envelope.result, 'Missing JSON-RPC result');
    return envelope.result;
  }
  try {
    const probe = { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} };
    for (const method of ['POST', 'GET', 'DELETE']) {
      await request(`${method} missing key`, method, method === 'POST' ? probe : undefined, undefined, 403);
      await request(`${method} wrong key`, method, method === 'POST' ? probe : undefined, 'invalid-smoke-test-key', 403);
    }
    await request('POST empty key', 'POST', probe, '', 403);
    const init = await rpc('initialize', { protocolVersion: version, capabilities: {},
      clientInfo: { name: 'lutech-deployment-smoke', version: '1.0' } });
    assert.ok(typeof init.protocolVersion === 'string', 'Missing negotiated protocol version');
    version = init.protocolVersion;
    const notification = await request('notifications/initialized', 'POST',
      { jsonrpc: '2.0', method: 'notifications/initialized' }, key.value, 202);
    assert.equal(notification.body, '', 'Notification returned unexpected body');
    const list = await rpc('tools/list', {});
    const expected = ['search_services', 'get_service_fields', 'create_estimate', 'add_service',
      'build_estimate', 'validate_estimate', 'export_estimate', 'import_estimate', 'get_server_info'];
    assert.deepEqual(list.tools.map(t => t.name).sort(), expected.sort(), 'Unexpected tool surface');
    const info = await rpc('tools/call', { name: 'get_server_info', arguments: {} });
    assert.notEqual(info.isError, true, 'get_server_info failed');
    assert.deepEqual(JSON.parse(info.content.find(c => c.type === 'text').text).tools.sort(), expected);
    for (const method of ['GET', 'DELETE']) {
      await request(`${method} valid key`, method, undefined, key.value, 405);
    }
    console.log(JSON.stringify({ result: 'PASSED', apiUrl: url.href, protocolVersion: version,
      toolCount: list.tools.length, checks: evidence.length,
      pending: ['disabled/duplicate key tests', 'DynamoDB cross-invocation and cold-start persistence',
        'long-running path', 'Copilot Studio tenant acceptance', 'key rotation'] }));
  } finally {
    key = null;
  }
}

main().catch(error => {
  console.error(`Smoke test FAILED: ${error.message}`);
  process.exitCode = 1;
});

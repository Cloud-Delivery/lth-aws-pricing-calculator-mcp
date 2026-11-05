import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { allowedTools, filterResponse, isObject, rpcError, rpcId, RpcId } from './protocol';
import { LocalServer, Upstream } from './server';

function response(statusCode: number, body: string, headers: Record<string, string> = {}): APIGatewayProxyResult {
  return { statusCode, headers: { 'content-type': 'application/json', ...headers },
    body, isBase64Encoded: false };
}

function forwardHeaders(event: APIGatewayProxyEvent): Record<string, string> {
  const result: Record<string, string> = {};
  const allowed = new Set(['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version',
    'last-event-id']);
  for (const [name, value] of Object.entries(event.headers)) {
    const lower = name.toLowerCase();
    if (allowed.has(lower) && typeof value === 'string') result[lower] = value;
  }
  for (const [name, values] of Object.entries(event.multiValueHeaders ?? {})) {
    const lower = name.toLowerCase();
    if (!allowed.has(lower)) continue;
    if (!values || values.length !== 1) throw new Error('Ambiguous MCP header');
    result[lower] = values[0];
  }
  return result;
}

export function createHandler(
  upstream: Upstream,
  deadlineMs = 25000,
  log: (event: { code: string; requestId: string }) => void = event => console.error(JSON.stringify(event)),
) {
  let busy = false;
  return async (event: APIGatewayProxyEvent, context: Pick<Context, 'getRemainingTimeInMillis' | 'callbackWaitsForEmptyEventLoop'>): Promise<APIGatewayProxyResult> => {
    context.callbackWaitsForEmptyEventLoop = false;
    const started = Date.now();
    const requestId = event.requestContext.requestId;
    const fail = (status: number, id: RpcId, code: number, message: string, reason: string) => {
      log({ code: reason, requestId });
      return response(status, rpcError(id, code, message));
    };
    if (event.resource !== '/mcp') return fail(404, null, -32600, 'Unknown MCP route', 'unknown-route');
    if (!['POST', 'GET', 'DELETE'].includes(event.httpMethod)) {
      return fail(405, null, -32600, 'Method not allowed', 'unsupported-method');
    }
    if (busy) return fail(503, null, -32603, 'Execution environment is busy', 'concurrent-invocation');
    let payload: unknown;
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
    let headers: Record<string, string>;
    try { headers = forwardHeaders(event); }
    catch { return fail(400, null, -32600, 'Ambiguous MCP headers', 'invalid-headers'); }
    if (event.httpMethod === 'POST') {
      if (headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return fail(415, null, -32600, 'Expected application/json', 'invalid-content-type');
      }
      try { payload = JSON.parse(body); }
      catch { return fail(400, null, -32700, 'Invalid JSON', 'parse-error'); }
      if (!isObject(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string'
        || (payload.id !== undefined && typeof payload.id !== 'string' && typeof payload.id !== 'number')
        || (payload.params !== undefined && !isObject(payload.params))) {
        return fail(400, null, -32600, 'Invalid JSON-RPC request; batches unsupported', 'invalid-request');
      }
    }
    const method = isObject(payload) && typeof payload.method === 'string' ? payload.method : '';
    const id = isObject(payload) ? rpcId(payload.id) : null;
    const params = isObject(payload) && isObject(payload.params) ? payload.params : undefined;
    const toolName = typeof params?.name === 'string' ? params.name : undefined;
    if (method === 'tools/call' && toolName && !allowedTools.has(toolName)) {
      return fail(200, id, -32602, 'Tool unavailable in this deployment (Chromium excluded)', 'blocked-tool');
    }
    busy = true;
    const controller = new AbortController();
    const remaining = Math.min(deadlineMs - (Date.now() - started), context.getRemainingTimeInMillis() - 1000);
    const timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
    if (remaining <= 0) controller.abort();
    try {
      const result = await upstream.forward(event.httpMethod, headers, body, controller.signal);
      result.body = filterResponse(result.body, result.headers['content-type'] ?? '', method, toolName);
      const output = response(result.status, result.body, result.headers);
      if (Buffer.byteLength(JSON.stringify(output)) > 5.5 * 1024 * 1024) {
        throw new Error('Proxy response exceeds Lambda buffered limit');
      }
      return output;
    } catch {
      await upstream.stop();
      return controller.signal.aborted
        ? fail(504, id, -32603, 'MCP request deadline exceeded; reload state before retrying writes', 'deadline')
        : fail(502, id, -32603, 'MCP upstream failed; reload state before retrying writes', 'upstream-failure');
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };
}

export const handler = createHandler(new LocalServer());

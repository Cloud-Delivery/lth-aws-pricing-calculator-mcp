export type RpcId = string | number | null;
export type JsonObject = Record<string, unknown>;

export const allowedTools = new Set([
  'search_services', 'get_service_fields', 'create_estimate', 'add_service',
  'build_estimate', 'validate_estimate', 'export_estimate', 'import_estimate',
  'get_server_info',
]);

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rpcId(value: unknown): RpcId {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

export function rpcError(id: RpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function filterEnvelope(value: unknown, method: string, toolName?: string): unknown {
  if (!isObject(value) || !isObject(value.result)) return value;
  const result = value.result;
  if (method === 'tools/list') {
    if (!Array.isArray(result.tools)) throw new Error('Invalid upstream tools list');
    result.tools = result.tools.filter(tool => isObject(tool)
      && typeof tool.name === 'string' && allowedTools.has(tool.name));
  }
  if (method === 'tools/call' && toolName === 'get_server_info') {
    if (!Array.isArray(result.content)) throw new Error('Invalid upstream server info');
    for (const item of result.content) {
      if (!isObject(item) || item.type !== 'text' || typeof item.text !== 'string') continue;
      const info: unknown = JSON.parse(item.text);
      if (!isObject(info) || !Array.isArray(info.tools)) throw new Error('Invalid upstream server info tools');
      info.tools = info.tools.filter(tool => typeof tool === 'string' && allowedTools.has(tool));
      item.text = JSON.stringify(info);
    }
  }
  return value;
}

export function filterResponse(body: string, contentType: string, method: string, toolName?: string): string {
  if (method !== 'tools/list' && !(method === 'tools/call' && toolName === 'get_server_info')) {
    return body;
  }
  if (contentType.startsWith('application/json')) {
    return JSON.stringify(filterEnvelope(JSON.parse(body), method, toolName));
  }
  if (contentType.startsWith('text/event-stream')) {
    return body.split(/\r?\n\r?\n/).map(event => {
      const lines = event.split(/\r?\n/);
      const data = lines.filter(line => line.startsWith('data:'));
      if (!data.length) return event;
      const text = data.map(line => line.slice(5).replace(/^ /, '')).join('\n');
      const filtered = JSON.stringify(filterEnvelope(JSON.parse(text), method, toolName));
      const others = lines.filter(line => !line.startsWith('data:'));
      return [...others, `data: ${filtered}`].join('\n');
    }).join('\n\n');
  }
  throw new Error('Unsupported upstream MCP content type');
}

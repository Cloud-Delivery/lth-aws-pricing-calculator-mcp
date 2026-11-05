import { ChildProcess, spawn } from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Upstream {
  forward(method: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<UpstreamResponse>;
  stop(): Promise<void>;
}

export class LocalServer implements Upstream {
  private child?: ChildProcess;
  private ready = false;

  constructor(
    private readonly entrypoint = path.join(__dirname, 'server', 'mcp-server.cjs'),
    private readonly port = Number(process.env.PORT ?? '8000'),
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port');
  }

  private async start(signal: AbortSignal): Promise<void> {
    if (this.child?.exitCode === null && this.ready) return;
    await this.stop();
    signal.throwIfAborted();
    this.ready = false;
    const child = spawn(process.execPath, [this.entrypoint], {
      env: { ...process.env, MCP_TRANSPORT: 'http', HOST: '127.0.0.1',
        PORT: String(this.port), TRACE: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let failure: Error | undefined;
    child.once('error', () => { failure = new Error('Upstream spawn failed'); });
    child.stdout?.resume();
    // Inspect only the bounded startup marker; never publish child payloads/errors.
    let marker = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      marker = (marker + chunk.toString('utf8')).slice(-256);
      if (marker.includes('MCP server listening on')) this.ready = true;
    });
    while (!this.ready) {
      signal.throwIfAborted();
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Upstream exited during startup');
      await delay(20, undefined, { signal });
    }
  }

  async forward(method: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<UpstreamResponse> {
    await this.start(signal);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: this.port, path: '/mcp', method, signal,
        headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
      }, res => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            res.destroy(new Error('Upstream response exceeds buffered limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('aborted', () => reject(new Error('Upstream response aborted')));
        res.once('end', () => {
          const resultHeaders: Record<string, string> = {};
          for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'allow']) {
            const value = res.headers[name];
            if (typeof value === 'string') resultHeaders[name] = value;
          }
          resolve({ status: res.statusCode ?? 502, headers: resultHeaders,
            body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.once('error', reject);
      req.end(body);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
}

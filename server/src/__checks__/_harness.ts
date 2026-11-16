// Shared by keys / quota / scans / routes checks: start the real server as a child process, make sessions, call it.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { query } from '../db/pool.js';

export const ORIGIN = 'http://localhost:5173';
const ROOT = path.resolve(import.meta.dirname, '../../..');

export interface TestServer {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/** Runs server/src/index.ts with accounts on (when DATABASE_URL is set) and no network (OFFLINE=1). */
export async function startServer(env: Record<string, string | undefined> = {}): Promise<TestServer> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), ['server/src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      OFFLINE: '1',
      GEMINI_API_KEY: '',
      GITHUB_CLIENT_ID: 'test-client',
      GITHUB_CLIENT_SECRET: 'test-secret',
      PUBLIC_ORIGIN: ORIGIN,
      TRUST_PROXY: '',
      ...env,
    } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) throw new Error(`server did not start:\n${log}`);
  }
  return {
    url,
    port,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 4000).unref();
      }),
  };
}

/** Insert a sessions row for the user and return the cookie header value. */
export async function sessionCookie(userId: string): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [createHash('sha256').update(id).digest(), userId]);
  return `vulnera_sid=${id}`;
}

export interface Reply {
  status: number;
  headers: Headers;
  body: any;
}

/** JSON request. `cookie` adds a session (with the same-origin header a browser sends); `key` adds a Bearer key. */
export async function call(s: TestServer, method: string, p: string, o: { cookie?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) {
    headers.cookie = o.cookie;
    headers.origin = ORIGIN;
  }
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${s.url}${p}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text (NDJSON etc.) */
  }
  return { status: res.status, headers: res.headers, body };
}

/** A lockfile with no packages: the scan finishes without any network. */
export const EMPTY_LOCKFILE = { name: 'empty', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'empty', version: '1.0.0' } } };

/** Send only the headers of a POST that promises `bytes` of body and never sends it; resolves with the status and elapsed ms. */
export function headersOnlyPost(s: TestServer, p: string, headers: Record<string, string>, bytes: number): Promise<{ status: number; ms: number; body: string }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: s.port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(bytes), ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, ms: Date.now() - t0, body }));
    });
    req.on('error', reject);
    req.flushHeaders(); // no body follows: a server that waits for it would hang until the timeout
    setTimeout(() => {
      req.destroy();
      reject(new Error('no response without a body: the server is waiting for it'));
    }, 4000).unref();
  });
}

import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

// Outbound network setup, imported first by index.ts. Two things a browser does that Node's fetch does not:
//
// 1. Trust the operating system's certificates. Office, college and venue networks often inspect HTTPS with
//    their own certificate, installed in the OS (so the browser works) but unknown to Node, which then fails
//    every request with UNABLE_TO_VERIFY_LEAF_SIGNATURE or SELF_SIGNED_CERT_IN_CHAIN.
// 2. Use the network's proxy when HTTPS_PROXY / HTTP_PROXY is set (NO_PROXY is honoured).

function trustedCAs(): string[] | undefined {
  const t = tls as typeof tls & { getCACertificates?: (kind: string) => string[] };
  if (typeof t.getCACertificates !== 'function') return undefined; // Node < 22.15: bundled roots + NODE_EXTRA_CA_CERTS only
  const set = new Set<string>();
  for (const kind of ['default', 'system', 'extra']) {
    try {
      for (const c of t.getCACertificates(kind)) set.add(c);
    } catch {
      /* kind not supported on this Node */
    }
  }
  // NODE_EXTRA_CA_CERTS set in .env is loaded after Node has started, so read the file here as well.
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  if (extra) {
    try {
      for (const pem of readFileSync(extra, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) set.add(pem);
    } catch {
      console.warn(`[net] NODE_EXTRA_CA_CERTS points at ${extra}, which could not be read`);
    }
  }
  return set.size ? [...set] : undefined;
}

const ca = trustedCAs();
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent(ca ? { connect: { ca }, requestTls: { ca }, proxyTls: { ca } } : {}));
  console.log(`[net] outbound requests use the proxy in ${process.env.HTTPS_PROXY || process.env.https_proxy ? 'HTTPS_PROXY' : 'HTTP_PROXY'}`);
} else if (ca) {
  setGlobalDispatcher(new Agent({ connect: { ca } }));
}
if (ca) console.log(`[net] trusting ${ca.length} certificates (Node's bundled roots + this computer's certificate store)`);

/** The low-level reason behind a failed fetch: an error code such as ECONNRESET, or TIMEOUT. */
export function reasonOf(e: unknown): string {
  const err = e as { name?: string; message?: string; code?: unknown; cause?: { code?: unknown; message?: string; cause?: { code?: unknown } } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'TIMEOUT';
  // fetch wraps the real error several levels deep (TypeError "fetch failed" → … → UND_ERR_ABORTED): walk the chain.
  let deepest: string | undefined;
  for (let c: unknown = e, depth = 0; c && depth < 8; c = (c as { cause?: unknown }).cause, depth++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    const msg = (c as { message?: unknown }).message;
    if (typeof msg === 'string' && msg && msg !== 'fetch failed') deepest = msg;
  }
  return deepest ?? (err?.message || String(e));
}

/** One plain sentence on what a network failure means and what to do about it. */
export function adviceFor(reason: string): string {
  const r = reason.toUpperCase();
  if (r === 'TIMEOUT') return 'The service took too long to answer from this network.';
  if (/ENOTFOUND|EAI_AGAIN/.test(r)) return 'This computer could not look the service up: no internet connection, or a DNS problem.';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL/.test(r)) {
    return 'The network is intercepting secure connections. Add its certificate file to .env as NODE_EXTRA_CA_CERTS=/path/to/cert.pem and restart (ask the network admin for it).';
  }
  if (/HTTP 40[37]|HTTP 429/.test(r)) return 'The service refused the request from this network (a firewall, a proxy rule or a rate limit).';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT|UND_ERR_SOCKET|UND_ERR_ABORTED|CANCELLED|PROXY|EPIPE/.test(r)) {
    return 'The connection was blocked or dropped. On a college or office network that needs a proxy, add HTTPS_PROXY=http://host:port to .env and restart, or switch to a phone hotspot.';
  }
  return 'The service could not be reached from this network.';
}

/** A user-facing message for a data source that failed, e.g. "Could not reach OSV.dev. … (ECONNRESET)". */
export function sourceMessage(source: string, e: unknown): string {
  const reason = reasonOf(e);
  return `Could not reach ${source}. ${adviceFor(reason)} (${reason})`;
}

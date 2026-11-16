import { adviceFor, reasonOf } from './net.js';

// Connection check: can this server reach every service a scan needs? Run at startup (printed in the
// terminal) and on demand from the app (GET /api/doctor). Each probe is one small request.

export interface Probe {
  id: 'osv' | 'epss' | 'npm' | 'github' | 'raw' | 'gemini';
  name: string;
  needed: string; // what fails without it
  ok: boolean;
  ms: number;
  detail: string; // "HTTP 200" or the reason it failed
  advice?: string;
}

const TIMEOUT_MS = 8000;

const PROBES: { id: Probe['id']; name: string; needed: string; url: string; init?: RequestInit; okWhen?: (s: number) => boolean }[] = [
  { id: 'osv', name: 'OSV.dev', needed: 'every scan (vulnerability facts)', url: 'https://api.osv.dev/v1/vulns/GHSA-phwq-j96m-2c2q' },
  { id: 'epss', name: 'FIRST EPSS', needed: 'exploit probability (scan still runs without it)', url: 'https://api.first.org/data/v1/epss?cve=CVE-2022-29078' },
  { id: 'npm', name: 'npm registry', needed: 'verifying upgrade versions', url: 'https://registry.npmjs.org/-/ping' },
  // codeload answers 404 for a missing archive: any HTTP answer proves the host is reachable.
  { id: 'github', name: 'GitHub downloads (codeload)', needed: 'scanning by GitHub link', url: 'https://codeload.github.com/OWASP/NodeGoat/tar.gz/HEAD', init: { method: 'HEAD' }, okWhen: (s) => s < 500 && s !== 403 && s !== 407 },
  { id: 'raw', name: 'GitHub raw files', needed: 'GitHub-link fallback (lockfile only)', url: 'https://raw.githubusercontent.com/OWASP/NodeGoat/HEAD/package.json', init: { method: 'HEAD' } },
];

async function probe(p: (typeof PROBES)[number] | { id: 'gemini'; name: string; needed: string; url: string; init?: RequestInit; okWhen?: (s: number) => boolean }): Promise<Probe> {
  const t0 = Date.now();
  try {
    const res = await fetch(p.url, { ...p.init, headers: { 'User-Agent': 'vulnera-doctor', ...(p.init?.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel().catch(() => {});
    const ok = p.okWhen ? p.okWhen(res.status) : res.ok;
    const detail = `HTTP ${res.status}`;
    return { id: p.id, name: p.name, needed: p.needed, ok, ms: Date.now() - t0, detail, ...(ok ? {} : { advice: p.id === 'gemini' && (res.status === 400 || res.status === 403) ? 'Gemini rejected the API key. Check GEMINI_API_KEY in .env (no quotes or spaces), then restart.' : adviceFor(detail) }) };
  } catch (e) {
    const reason = reasonOf(e);
    return { id: p.id, name: p.name, needed: p.needed, ok: false, ms: Date.now() - t0, detail: reason, advice: adviceFor(reason) };
  }
}

export async function runDoctor(): Promise<{ offline: boolean; probes: Probe[] }> {
  const list: Parameters<typeof probe>[0][] = [...PROBES];
  const key = process.env.GEMINI_API_KEY?.trim();
  if (key) {
    // Lists models with the key in a header (never in the URL): proves both reachability and that the key is valid.
    list.push({ id: 'gemini', name: 'Google Gemini', needed: 'the AI code check', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', init: { headers: { 'x-goog-api-key': key } } });
  }
  const probes = await Promise.all(list.map(probe));
  return { offline: process.env.OFFLINE === '1', probes };
}

let last: { at: number; value: Promise<Awaited<ReturnType<typeof runDoctor>>> } | undefined;

/** runDoctor() with a 60 s result cache, so repeated calls cannot fan out into outbound requests. */
export function runDoctorCached(now = Date.now()) {
  if (!last || now - last.at > 60_000) {
    const value = runDoctor();
    value.catch(() => {
      if (last?.value === value) last = undefined;
    });
    last = { at: now, value };
  }
  return last.value;
}

export function printDoctor(r: { offline: boolean; probes: Probe[] }): void {
  const bad = r.probes.filter((p) => !p.ok);
  console.log('\nConnection check');
  for (const p of r.probes) console.log(`  ${p.ok ? 'OK     ' : 'BLOCKED'}  ${p.name.padEnd(28)} ${p.detail}${p.ok ? '' : `  needed for: ${p.needed}`}`);
  if (!process.env.GEMINI_API_KEY?.trim()) console.log('  SKIP     Google Gemini                no GEMINI_API_KEY in .env: the AI code check is off');
  if (bad.length) {
    console.log('\n  What to do:');
    for (const a of new Set(bad.map((p) => p.advice))) console.log(`  - ${a}`);
    if (r.offline) console.log('  (OFFLINE=1 is set, so only the bundled sample and demo data are expected to work.)');
  } else console.log('  Everything a scan needs is reachable.');
  console.log('');
}

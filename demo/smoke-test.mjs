#!/usr/bin/env node
// Vulnera smoke test: drives the running server through the main paths and prints PASS / FAIL.
// Usage:  node demo/smoke-test.mjs                 (server on http://localhost:8787)
//         node demo/smoke-test.mjs --online        (also scans a public GitHub repo)
//         BASE=http://localhost:9000 node demo/smoke-test.mjs
// Needs Node 18+ (built-in fetch). Reads files from demo/ only; changes nothing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const ONLINE = process.argv.includes('--online');
const HERE = import.meta.dirname;
const results = [];

const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const readJson = (p) => JSON.parse(readFileSync(path.join(HERE, p), 'utf8'));

function sources(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(name)) out.push({ path: path.relative(dir, full).split(path.sep).join('/'), content: readFileSync(full, 'utf8') });
    }
  };
  walk(path.join(HERE, dir, 'src'));
  return out;
}

async function post(body) {
  const res = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function stream(body) {
  const res = await fetch(`${BASE}/api/scan/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) return { status: res.status, steps: [], end: await res.json().catch(() => null) };
  const text = await res.text();
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  return { status: res.status, steps: lines.filter((l) => l.type === 'step'), end: lines.at(-1) };
}

/** Architecture files (compose, OpenAPI, Markdown, package.json) next to a demo project's code. */
function contextFiles(dir) {
  const root = path.join(HERE, dir);
  return readdirSync(root)
    .filter((n) => /\.(ya?ml|md)$|^package\.json$/.test(n))
    .map((n) => ({ path: n, content: readFileSync(path.join(root, n), 'utf8') }));
}

const tiers = (fs) => ['FIX_NOW', 'FIX_SPRINT', 'PLAN', 'MONITOR'].map((t) => fs.filter((f) => f.tier === t).length).join('/');

async function main() {
  console.log(`Vulnera smoke test against ${BASE}\n`);

  // 1. Server up
  let health;
  try {
    health = await (await fetch(`${BASE}/api/health`)).json();
  } catch {
    ok('server reachable', false, `nothing at ${BASE}. Start it first: see demo/README.md`);
    return;
  }
  ok('server reachable', health.ok === true, `offline=${health.offline} gemini=${health.gemini}`);

  // Connection check: the first thing to read when scans fail
  try {
    const doc = await (await fetch(`${BASE}/api/doctor`)).json();
    console.log('\n      Connection check (from the server):');
    for (const p of doc.probes) console.log(`        ${p.ok ? 'ok     ' : 'BLOCKED'} ${p.name.padEnd(28)} ${p.detail}`);
    for (const a of new Set(doc.probes.filter((p) => !p.ok).map((p) => p.advice))) console.log(`        → ${a}`);
    console.log('');
    const osv = doc.probes.find((p) => p.id === 'osv');
    if (!health.offline) ok('server can reach OSV.dev', osv?.ok === true, osv?.ok ? '' : `${osv?.detail}: scans of new projects will fail until this is fixed`);
    const gem = doc.probes.find((p) => p.id === 'gemini');
    if (gem) ok('Gemini API key works', gem.ok, gem.ok ? '' : gem.advice);
  } catch {
    ok('connection check', null, 'this server has no /api/doctor (old build?)');
  }
  const app = await fetch(`${BASE}/`);
  ok('web page served', app.ok && (await app.text()).includes('<div id="root">'), app.ok ? 'production build' : `HTTP ${app.status}: run "npm run build" first, or use the dev server on :5173`);

  // 2. Bundled sample, streamed: the agent trace
  const s = await stream({ sample: true });
  const r = s.end?.result;
  ok('sample scan streams agent steps', s.steps.length >= 10 && s.end?.type === 'result', `${new Set(s.steps.map((x) => x.step.id)).size} steps`);
  if (r) {
    ok('sample scan has findings and tiers', r.findings.length > 0, `${r.packageCount} packages, ${r.findings.length} findings, tiers ${tiers(r.findings)}`);
    ok('sample scan has verified upgrades', r.plans.some((p) => p.to), `${r.plans.filter((p) => p.to).length}/${r.plans.length} verified`);
    const tools = new Set(s.steps.map((x) => x.step.tool));
    ok('agent used plan, osv, enrich, rank, verify', ['plan', 'osv', 'enrich', 'rank', 'verify'].every((t) => tools.has(t)), [...tools].join(', '));
  }

  // 3. Uploaded demo projects (need live data unless their answers were saved for offline mode)
  if (health.offline) {
    ok('upload: kirana-billing', null, 'server is in OFFLINE mode; restart without OFFLINE=1 to test uploads');
    ok('upload: clean-app', null, 'same');
  } else {
    const k = await post({
      lockfile: readJson('projects/kirana-billing/package-lock.json'),
      sources: sources('projects/kirana-billing'),
      contextFiles: contextFiles('projects/kirana-billing'),
    });
    const kf = k.body?.findings ?? [];
    ok('upload: kirana-billing finds vulnerabilities', k.status === 200 && kf.length > 0, k.status === 200 ? `${kf.length} findings, tiers ${tiers(kf)}, AI ${k.body.aiStatus}` : k.body?.error);
    ok('upload: kirana-billing has Fix now items', kf.some((f) => f.tier === 'FIX_NOW'), `${kf.filter((f) => f.tier === 'FIX_NOW').length} fix now`);
    const level = (name) => kf.find((f) => f.pkg.name === name)?.exposure?.level;
    ok(
      'architecture: lodash behind login, node-fetch internal, axios public',
      k.status === 200 ? level('lodash') === 'login' && level('node-fetch') === 'internal' && level('axios') === 'public' : null,
      k.status === 200 ? `lodash ${level('lodash')}, node-fetch ${level('node-fetch')}, axios ${level('axios')}` : 'upload failed, see above',
    );
    ok(
      'architecture: docs/OpenAPI vs code drift on /supplier is flagged',
      k.status === 200 ? (k.body.context?.conflicts ?? []).filter((c) => c.includes('/supplier')).length === 2 : null,
      k.status === 200 ? `${k.body.context?.conflicts?.length ?? 0} conflicts, ${kf.filter((f) => f.exposure?.lowered).length} findings moved down` : '',
    );
    ok('upload: dev-only packages land in Monitor', k.status === 200 ? kf.filter((f) => f.pkg.dev).every((f) => f.tier === 'MONITOR') : null, k.status === 200 ? `${kf.filter((f) => f.pkg.dev).length} dev findings` : 'upload failed, see above');
    if (health.gemini) {
      const cited = kf.filter((f) => f.ai?.verdict === 'USES_VULNERABLE_API');
      ok('AI code check cites the demo routes', cited.length > 0, cited.map((f) => `${f.pkg.name} → ${f.ai.citations[0]?.file}:${f.ai.citations[0]?.line}`).slice(0, 3).join('; ') || 'no "uses" verdicts');
    } else ok('AI code check', null, 'no GEMINI_API_KEY on the server; findings show "Not assessed"');

    const c = await post({ lockfile: readJson('projects/clean-app/package-lock.json') });
    ok('upload: clean-app has no findings', c.status === 200 && c.body.findings.length === 0, c.status === 200 ? `${c.body.packageCount} packages, ${c.body.findings.length} findings` : c.body?.error);
  }

  // 4. Bad inputs are refused with a message, never a crash
  const v1 = await post({ lockfile: readJson('bad-inputs/lockfile-v1-npm6.json') });
  ok('refuses lockfileVersion 1', v1.status === 400 && /lockfileVersion 1/.test(v1.body?.error ?? ''), v1.body?.error?.slice(0, 70));
  const empty = await post({ lockfile: readJson('bad-inputs/empty-packages.json') });
  ok('refuses an empty lockfile', empty.status === 400, empty.body?.error?.slice(0, 70));
  const none = await post({});
  ok('refuses an empty request', none.status === 400, none.body?.error?.slice(0, 70));
  const gl = await stream({ repoUrl: 'https://gitlab.com/a/b' });
  ok('refuses a non-GitHub link', gl.end?.type === 'error' && /github\.com/.test(gl.end.error), gl.end?.error);

  // 5. Production routing
  const asset = await fetch(`${BASE}/assets/does-not-exist.js`);
  ok('missing asset is a 404, not the page', asset.status === 404, `HTTP ${asset.status}`);
  const route = await fetch(`${BASE}/india`);
  ok('app routes load (/india)', route.ok, `HTTP ${route.status}`);

  // 6. Optional: a real public repository by link
  if (ONLINE && !health.offline) {
    const g = await stream({ repoUrl: 'https://github.com/OWASP/NodeGoat' });
    const gr = g.end?.result;
    ok('GitHub link: OWASP/NodeGoat', g.end?.type === 'result', gr ? `${gr.repo?.sourceFiles} source files, ${gr.findings.length} findings, tiers ${tiers(gr.findings)}` : g.end?.error);
  } else ok('GitHub link scan', null, ONLINE ? 'server is offline' : 'run with --online to include it');

  const failed = results.filter((x) => x.pass === false).length;
  const passed = results.filter((x) => x.pass === true).length;
  const skipped = results.filter((x) => x.pass === null).length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

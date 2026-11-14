// Run: npx tsx server/src/pipeline/__checks__/context.check.ts
// Architecture context: deployment files + import graph → exposure per package, and how that moves a tier.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ExposureVerdict, Package, SourceFile } from '../../types.js';
import { buildContext, isContextPath } from '../context.js';
import { parseLockfile } from '../parse.js';
import { applyExposure } from '../score.js';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${(e as Error).message.split('\n').join('\n     ')}`);
  }
}

/** Minimal v3 lockfile: direct deps `names` (each at 1.0.0), plus `extra` transitive edges. */
function lock(names: string[], extra: Record<string, string[]> = {}) {
  const packages: Record<string, unknown> = { '': { dependencies: Object.fromEntries(names.map((n) => [n, '1.0.0'])) } };
  for (const n of [...names, ...Object.values(extra).flat()]) {
    packages[`node_modules/${n}`] = { version: '1.0.0', dependencies: Object.fromEntries((extra[n] ?? []).map((d) => [d, '1.0.0'])) };
  }
  return { lockfileVersion: 3, packages };
}
const pkg = (name: string, o: Partial<Package> = {}): Package => ({ name, version: '1.0.0', direct: true, dev: false, path: [name], ...o });
const src = (p: string, content: string): SourceFile => ({ path: p, content });

// ---------- the kirana-billing demo project ----------

const DEMO = path.resolve(import.meta.dirname, '../../../../demo/projects/kirana-billing');
const sources: SourceFile[] = [];
const contextFiles: SourceFile[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const f = path.join(d, n);
    const rel = path.relative(DEMO, f).split(path.sep).join('/');
    if (statSync(f).isDirectory()) walk(f);
    else if (/\.js$/.test(n)) sources.push(src(rel, readFileSync(f, 'utf8')));
    else if (isContextPath(rel)) contextFiles.push(src(rel, readFileSync(f, 'utf8')));
  }
};
walk(DEMO);
const kLock = JSON.parse(readFileSync(path.join(DEMO, 'package-lock.json'), 'utf8'));
const kirana = buildContext({ lockfile: kLock, sources, contextFiles })!;
const kPkgs = new Map(parseLockfile(kLock).map((p) => [p.name, p]));
const kLevel = (n: string) => kirana.exposureOf(kPkgs.get(n)!)?.level;

check('kirana: reads compose, OpenAPI, Markdown, package.json', () => {
  const kinds = new Set(kirana.context.files.map((f) => f.kind));
  for (const k of ['compose', 'openapi', 'markdown', 'manifest'] as const) assert.ok(kinds.has(k), k);
});
check('kirana: web is public, supplier-sync is internal, both linked to their start file', () => {
  const web = kirana.context.entryPoints.find((e) => e.component === 'web')!;
  const sync = kirana.context.entryPoints.find((e) => e.component === 'supplier-sync')!;
  assert.deepEqual([web.exposure, web.file], ['public', 'src/server.js']);
  assert.deepEqual([sync.exposure, sync.file], ['internal', 'src/jobs/supplier-sync.js']);
  assert.ok(web.evidence.some((e) => e.quote.includes('8080:3000')));
});
check('kirana: /admin is mounted behind requireOwner', () => {
  assert.deepEqual(kirana.context.protectedMounts.map((m) => [m.prefix, m.guard]), [['/admin', 'requireOwner']]);
});
check('kirana: lodash only in the owner-only router → login', () => assert.equal(kLevel('lodash'), 'login'));
check('kirana: node-fetch only in the nightly job → internal', () => assert.equal(kLevel('node-fetch'), 'internal'));
check('kirana: axios, ejs, jsonwebtoken and transitive qs stay public', () => {
  for (const n of ['axios', 'ejs', 'jsonwebtoken', 'qs']) assert.equal(kLevel(n), 'public', n);
});
check('kirana: dev-only packages get no exposure verdict', () => assert.equal(kirana.exposureOf(kPkgs.get('mocha')!), undefined));
check('kirana: docs and OpenAPI claiming /supplier needs login are flagged against the code', () => {
  const c = kirana.context.conflicts.filter((x) => x.includes('/supplier'));
  assert.equal(c.length, 2, kirana.context.conflicts.join('\n'));
  assert.ok(c.some((x) => x.startsWith('ARCHITECTURE.md:')) && c.some((x) => x.startsWith('openapi.yaml:')));
});
check('kirana: the graph is complete, so "unreached" could be claimed', () => assert.equal(kirana.context.confident, true));

// ---------- other deployment formats ----------

check('kubernetes: Ingress → public, ClusterIP-only → internal, CronJob → offline', () => {
  const k8s = `apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          command: ["node", "src/api.js"]
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec:
  selector: { app: api }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: public }
spec:
  rules:
    - http:
        paths:
          - path: /
            backend: { service: { name: api-svc, port: { number: 80 } } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: queue }
spec:
  template:
    metadata: { labels: { app: queue } }
    spec:
      containers: [{ name: q, args: ["node", "src/queue.js"] }]
---
apiVersion: v1
kind: Service
metadata: { name: queue-svc }
spec: { selector: { app: queue }, type: ClusterIP }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: report }
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers: [{ name: r, command: ["node", "src/report.js"] }]
`;
  const b = buildContext({
    lockfile: lock(['a', 'b', 'c']),
    contextFiles: [src('deploy/k8s.yaml', k8s)],
    sources: [src('src/api.js', "require('a')"), src('src/queue.js', "require('b')"), src('src/report.js', "require('c')")],
  })!;
  assert.deepEqual(b.context.entryPoints.map((e) => [e.component, e.exposure, e.file]), [
    ['api', 'public', 'src/api.js'],
    ['queue', 'internal', 'src/queue.js'],
    ['report', 'offline', 'src/report.js'],
  ]);
  assert.deepEqual(['a', 'b', 'c'].map((n) => b.exposureOf(pkg(n))?.level), ['public', 'internal', 'offline']);
});

check('serverless.yml: HTTP with authorizer → login, schedule → offline', () => {
  const yml = `service: shop
functions:
  orders:
    handler: src/orders.handler
    events:
      - http: { path: orders, method: post, authorizer: aws_iam }
  nightly:
    handler: src/nightly.run
    events:
      - schedule: rate(1 day)
`;
  const b = buildContext({ lockfile: lock(['a', 'b']), contextFiles: [src('serverless.yml', yml)], sources: [src('src/orders.js', "import a from 'a'"), src('src/nightly.js', "import b from 'b'")] })!;
  assert.equal(b.exposureOf(pkg('a'))?.level, 'login');
  assert.equal(b.exposureOf(pkg('b'))?.level, 'offline');
});

check('Procfile + Dockerfile CMD on built output maps dist/*.js back to src/*.ts', () => {
  const b = buildContext({
    lockfile: lock(['a', 'b']),
    contextFiles: [src('Procfile', 'web: npm start\nworker: node dist/worker.js'), src('package.json', '{"scripts":{"start":"node dist/server.js"}}')],
    sources: [src('src/server.ts', "import a from 'a';"), src('src/worker.ts', "import b from 'b';")],
  })!;
  assert.deepEqual(b.context.entryPoints.map((e) => [e.component, e.exposure, e.file]), [
    ['web', 'public', 'src/server.ts'],
    ['worker', 'internal', 'src/worker.ts'],
  ]);
});

check('vulnexis.yml declaration; a conflict with compose keeps the more exposed reading', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [
      src('vulnexis.yml', 'components:\n  api:\n    entry: src/api.js\n    exposure: internal\n'),
      src('docker-compose.yml', 'services:\n  api:\n    command: node src/api.js\n    ports: ["80:80"]\n'),
    ],
    sources: [src('src/api.js', "require('a')")],
  })!;
  assert.equal(b.exposureOf(pkg('a'))?.level, 'public');
  assert.ok(b.context.conflicts.some((c) => c.includes('more exposed')));
});

check('README alone: "this service is only reachable inside the office VPN" → internal', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [src('README.md', '# Stock tool\n\nThis service is only reachable inside the office VPN.\n')],
    sources: [src('src/index.js', "const a = require('a');\nrequire('http').createServer().listen(3000);")],
  })!;
  const v = b.exposureOf(pkg('a'))!;
  assert.equal(v.level, 'internal');
  assert.ok(v.evidence.some((e) => e.file === 'README.md' && e.line === 3));
});

check('a package only used by a script no entry point runs → unreached (VEX: not in execute path)', () => {
  const b = buildContext({
    lockfile: lock(['a', 'b']),
    contextFiles: [src('package.json', '{"main":"src/server.js"}')],
    sources: [src('src/server.js', "require('a');\napp.listen(1)"), src('scripts/seed.js', "require('b')")],
  })!;
  const v = b.exposureOf(pkg('b'))!;
  assert.equal(v.level, 'unreached');
  assert.equal(v.vex, 'vulnerable_code_not_in_execute_path');
  assert.equal(b.exposureOf(pkg('a'))?.level, 'unknown');
});

check('dynamic require() makes the graph incomplete: never claims "unreached"', () => {
  const b = buildContext({
    lockfile: lock(['a', 'b']),
    contextFiles: [],
    sources: [src('src/server.js', "require('a');\nfor (const r of routes) require(`./routes/${r}`);\napp.listen(1)"), src('src/routes/x.js', "require('b')")],
  })!;
  assert.equal(b.context.confident, false);
  assert.equal(b.exposureOf(pkg('b'))?.level, 'unknown');
});

check('transitive package inherits the exposure of the direct dependency that pulls it in', () => {
  const b = buildContext({
    lockfile: lock(['framework', 'tool'], { framework: ['inner'] }),
    contextFiles: [src('docker-compose.yml', 'services:\n  web:\n    command: node app.js\n    ports: ["80:80"]\n')],
    sources: [src('app.js', "require('framework')")],
  })!;
  assert.equal(b.exposureOf(pkg('inner', { direct: false, path: ['framework', 'inner'] }))?.level, 'public');
});

check('open sign-up: the login wall does not lower the priority', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [],
    sources: [
      src('server.js', "const auth = require('./routes/auth');\nconst admin = require('./routes/admin');\napp.use('/auth', auth);\napp.use('/admin', requireAuth, admin);\napp.listen(1)"),
      src('routes/auth.js', "const router = express.Router();\nrouter.post('/register', (req, res) => {});"),
      src('routes/admin.js', "const router = express.Router();\nconst a = require('a');\nrouter.get('/x', () => {});"),
    ],
  })!;
  const v = b.exposureOf(pkg('a'))!;
  assert.equal(v.level, 'login');
  assert.ok(v.openSignup);
  assert.equal(applyExposure('FIX_NOW', { epss: 0.5, kev: false }, v), 'FIX_NOW');
});

check('lockfile only (no code): the most exposed component counts for every package', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [src('docker-compose.yml', 'services:\n  web:\n    ports: ["80:80"]\n  worker:\n    image: x\n')],
    sources: [],
  })!;
  assert.equal(b.exposureOf(pkg('a'))?.level, 'public');
});

// ---------- tier policy ----------

const x = (level: ExposureVerdict['level']): ExposureVerdict => ({ level, ssvc: 'controlled', via: [], reason: '', evidence: [], lowered: false });
check('policy: one step down for login / internal / offline / unreached', () => {
  for (const l of ['login', 'internal', 'offline', 'unreached'] as const) {
    assert.equal(applyExposure('FIX_NOW', { epss: 0.5, kev: false }, x(l)), 'FIX_SPRINT', l);
    assert.equal(applyExposure('FIX_SPRINT', { epss: 0.5, kev: false }, x(l)), 'PLAN', l);
  }
});
check('policy: never below Plan, never Monitor → anything', () => {
  assert.equal(applyExposure('PLAN', { epss: 0, kev: false }, x('unreached')), 'PLAN');
  assert.equal(applyExposure('MONITOR', { epss: 0, kev: false }, x('internal')), 'MONITOR');
});
check('policy: known-exploited (KEV) is never lowered', () => assert.equal(applyExposure('FIX_NOW', { epss: 0.9, kev: true }, x('offline')), 'FIX_NOW'));
check('policy: public and unknown change nothing', () => {
  assert.equal(applyExposure('FIX_NOW', { epss: 0.5, kev: false }, x('public')), 'FIX_NOW');
  assert.equal(applyExposure('FIX_SPRINT', { epss: 0.5, kev: false }, x('unknown')), 'FIX_SPRINT');
});

if (failed) {
  console.log(`\n${failed} CONTEXT CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CONTEXT CHECKS PASSED');

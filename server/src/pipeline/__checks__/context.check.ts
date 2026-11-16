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

check('both config file names are picked up from a repository', () => {
  for (const p of ['vulnera.yml', '.vulnera.yaml', 'vulnexis.yml', 'app/.vulnexis.yaml']) assert.equal(isContextPath(p), true, p);
});

check('legacy vulnexis.yml still read; a conflict with compose keeps the more exposed reading', () => {
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

check('vulnera.yml declaration (the current name) sets exposure', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [src('vulnera.yml', 'components:\n  api:\n    entry: src/api.js\n    exposure: internal\n')],
    sources: [src('src/api.js', "require('a')")],
  })!;
  assert.equal(b.exposureOf(pkg('a'))?.level, 'internal');
});

// Changed: this check used to expect "internal" (Markdown prose lowered the exposure). Markdown never changes exposure now.
check('README alone: "this service is only reachable inside the office VPN" → unknown, README kept as evidence', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [src('README.md', '# Stock tool\n\nThis service is only reachable inside the office VPN.\n')],
    sources: [src('src/index.js', "const a = require('a');\nrequire('http').createServer().listen(3000);")],
  })!;
  const v = b.exposureOf(pkg('a'))!;
  assert.equal(v.level, 'unknown');
  assert.equal(applyExposure('FIX_NOW', { epss: 0.5, kev: false }, v), 'FIX_NOW');
  const e = b.context.entryPoints[0]!;
  assert.equal(e.exposure, 'unknown');
  assert.ok(e.evidence.some((x) => x.file === 'README.md' && x.line === 3));
  assert.ok(b.context.conflicts.some((c) => c.startsWith('README.md:3')));
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

// ---------- review fixes: every check below failed on the old behaviour ----------

/** A public web service (compose, port published) running `server.js`, plus extra source files; the exposure of package `a`. */
function webLevel(sourcesIn: Record<string, string>, extra: Partial<Parameters<typeof buildContext>[0]> = {}, names = ['a']) {
  const b = buildContext({
    lockfile: lock(names),
    contextFiles: [src('docker-compose.yml', 'services:\n  web:\n    command: node server.js\n    ports: ["80:80"]\n')],
    sources: Object.entries(sourcesIn).map(([p, c]) => src(p, c)),
    ...extra,
  })!;
  return { b, level: (n = 'a') => b.exposureOf(pkg(n))?.level };
}
const SERVER = "const r = require('./r');\napp.use('/x', r);\napp.listen(1);";

check('1 compose: backend behind a proxy service is unknown, not internal', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [src('docker-compose.yml', 'services:\n  nginx:\n    image: nginx\n    ports: ["80:80"]\n  app:\n    command: node src/app.js\n')],
    sources: [src('src/app.js', "require('a')")],
  })!;
  const app = b.context.entryPoints.find((e) => e.component === 'app')!;
  assert.equal(app.exposure, 'unknown');
  assert.match(app.how, /nginx.*proxied|proxied.*nginx/);
  assert.equal(b.exposureOf(pkg('a'))?.level, 'unknown');
});
check('1 compose: localhost-bound ports are unknown and the text does not claim "publishes no ports"', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [src('docker-compose.yml', 'services:\n  app:\n    command: node src/app.js\n    ports: ["127.0.0.1:3000:3000"]\n')],
    sources: [src('src/app.js', "require('a')")],
  })!;
  const app = b.context.entryPoints[0]!;
  assert.equal(app.exposure, 'unknown');
  assert.ok(!/publishes no ports/.test(app.how), app.how);
});
check('1 compose: internal only on explicit evidence (internal:true networks, or no service publishes a port)', () => {
  const none = buildContext({ lockfile: lock(['a']), contextFiles: [src('docker-compose.yml', 'services:\n  app:\n    command: node src/app.js\n  db:\n    image: postgres\n')], sources: [src('src/app.js', "require('a')")] })!;
  assert.equal(none.context.entryPoints.find((e) => e.component === 'app')!.exposure, 'internal');
  const nets = buildContext({
    lockfile: lock(['a']),
    contextFiles: [src('docker-compose.yml', 'services:\n  nginx:\n    ports: ["80:80"]\n  app:\n    command: node src/app.js\n    networks: [back]\nnetworks:\n  back:\n    internal: true\n')],
    sources: [src('src/app.js', "require('a')")],
  })!;
  assert.equal(nets.context.entryPoints.find((e) => e.component === 'app')!.exposure, 'internal');
});
check('1 kirana: supplier-sync is still internal under the new compose rule (internal:true network)', () => {
  const sync = kirana.context.entryPoints.find((e) => e.component === 'supplier-sync')!;
  assert.equal(sync.exposure, 'internal');
  assert.match(sync.how, /internal networks/);
});

check('2 a file-level router.use(requireAuth) does not cover routes declared before it', () => {
  const before = webLevel({ 'server.js': SERVER, 'r.js': "const router = express.Router();\nconst a = require('a');\nrouter.get('/open', h);\nrouter.use(requireAuth);\nrouter.get('/secret', h);" });
  assert.equal(before.level(), 'public');
  const after = webLevel({ 'server.js': SERVER, 'r.js': "const router = express.Router();\nconst a = require('a');\nrouter.use(requireAuth);\nrouter.get('/secret', h);" });
  assert.equal(after.level(), 'login');
});
check('2 an app-level global guard only covers the mounts after it', () => {
  const late = webLevel({ 'server.js': "const r = require('./r');\napp.use('/x', r);\napp.use(requireAuth);\napp.listen(1);", 'r.js': "const router = express.Router();\nconst a = require('a');\nrouter.get('/x', h);" });
  assert.equal(late.level(), 'public');
  const early = webLevel({ 'server.js': "const r = require('./r');\napp.use(requireAuth);\napp.use('/x', r);\napp.listen(1);", 'r.js': "const router = express.Router();\nconst a = require('a');\nrouter.get('/x', h);" });
  assert.equal(early.level(), 'login');
});

check('3 optional / non-auth middleware is not a login wall', () => {
  for (const guard of ['optionalAuth', 'auth({ authRequired: false })', 'expressjwt({ secret, credentialsRequired: false })', 'rateLimitAuth', 'maybeAuth', 'sessionAuthLogger']) {
    const { level } = webLevel({ 'server.js': `const r = require('./r');\napp.use('/x', ${guard}, r);\napp.listen(1);`, 'r.js': "const router = express.Router();\nconst a = require('a');\nrouter.get('/x', h);" });
    assert.equal(level(), 'public', guard);
  }
  const real = webLevel({ 'server.js': "const r = require('./r');\napp.use('/x', requireAuth, r);\napp.listen(1);", 'r.js': "const router = express.Router();\nconst a = require('a');\nrouter.get('/x', h);" });
  assert.equal(real.level(), 'login');
  const login = webLevel({ 'server.js': "const r = require('./r');\napp.use('/x', isLoggedIn, r);\napp.listen(1);", 'r.js': "const router = express.Router();\nconst a = require('a');\nrouter.get('/x', h);" });
  assert.equal(login.level(), 'login');
});

check('4 NestJS: only a class-level auth guard counts; ThrottlerGuard on one method does not', () => {
  const nest = (body: string) => webLevel({ 'server.js': "require('./cats.controller');\napp.listen(1);", 'cats.controller.ts': `import a from 'a';\n${body}` }).level();
  assert.equal(nest("@Controller('cats')\nexport class Cats {\n  @UseGuards(ThrottlerGuard)\n  @Get() list() {}\n}"), 'public');
  assert.equal(nest("@Controller('cats')\nexport class Cats {\n  @UseGuards(JwtAuthGuard)\n  @Get() list() {}\n}"), 'public'); // method-level: one route only
  assert.equal(nest("@UseGuards(ThrottlerGuard)\n@Controller('cats')\nexport class Cats {}"), 'public');
  assert.equal(nest("@UseGuards(JwtAuthGuard)\n@Controller('cats')\nexport class Cats {}"), 'login');
});

check('5 prefix guards need a segment boundary: /api does not cover /api-public', () => {
  const l = (mount: string) => webLevel({ 'server.js': `const r = require('./r');\napp.use('/api', requireAuth);\napp.use('${mount}', r);\napp.listen(1);`, 'r.js': "const router = express.Router();\nconst a = require('a');\nrouter.get('/x', h);" }).level();
  assert.equal(l('/api-public'), 'public');
  assert.equal(l('/apiv2'), 'public');
  assert.equal(l('/api'), 'login');
  assert.equal(l('/api/v1'), 'login');
});

check('6 Markdown never lowers: "not publicly exposed until you set ADMIN_PASSWORD" stays unknown', () => {
  const b = buildContext({
    lockfile: lock(['a']),
    contextFiles: [src('README.md', '# Admin\n\nThis app is not publicly exposed until you set ADMIN_PASSWORD.\n')],
    sources: [src('src/index.js', "const a = require('a');\nrequire('http').createServer().listen(3000);")],
  })!;
  assert.equal(b.exposureOf(pkg('a'))?.level, 'unknown');
});

check('7 "unreached" only for clearly non-production importers', () => {
  const lv = (sourcesIn: Record<string, string>, ctxFiles: SourceFile[] = [], n = 'a') =>
    buildContext({ lockfile: lock(['a']), contextFiles: [src('package.json', '{"main":"server.js"}'), ...ctxFiles], sources: Object.entries(sourcesIn).map(([p, c]) => src(p, c)) })!.exposureOf(pkg(n))?.level;
  const server = "app.listen(1);";
  // browser code next to an Express server
  assert.equal(lv({ 'server.js': server, 'src/main.jsx': "import a from 'a';" }), 'unknown');
  // test and script files are fine
  assert.equal(lv({ 'server.js': server, 'test/x.test.js': "require('a')" }), 'unreached');
  assert.equal(lv({ 'server.js': server, 'scripts/seed.js': "require('a')", 'jest.config.js': "require('a')" }), 'unreached');
  // one production-looking importer spoils it
  assert.equal(lv({ 'server.js': server, 'scripts/seed.js': "require('a')", 'src/worker.js': "require('a')" }), 'unknown');
  // preloaded from a script, a Procfile or a Dockerfile
  const pj = (scripts: string) => src('package.json', `{"main":"server.js","scripts":${scripts}}`);
  assert.equal(lv({ 'server.js': server, 'scripts/x.js': "require('a')" }, [pj('{"start":"node -r a server.js"}')]), 'unknown');
  assert.equal(lv({ 'server.js': server, 'scripts/x.js': "require('a')" }, [pj('{"start":"node --require a server.js"}')]), 'unknown');
  assert.equal(lv({ 'server.js': server, 'scripts/x.js': "require('a')" }, [src('Dockerfile', 'FROM node\nCMD ["npx", "a", "server.js"]')]), 'unknown');
  assert.equal(lv({ 'server.js': server, 'scripts/x.js': "require('a')" }, [src('Procfile', 'web: node -r a server.js')]), 'unknown');
  // worker.js started by a non-start npm script
  assert.equal(lv({ 'server.js': server, 'worker.js': "require('a')" }, [pj('{"start":"node server.js","worker":"node worker.js"}')]), 'unknown');
  // nobody imports it at all
  assert.equal(lv({ 'server.js': server }), 'unknown');
});

check('8 frameworkRouted looks at workspace dependencies too (Next.js in a workspace)', () => {
  const lk = lock(['a']);
  (lk.packages as Record<string, unknown>)['apps/web'] = { name: 'web', dependencies: { next: '14.0.0' } };
  const b = buildContext({
    lockfile: lk,
    contextFiles: [src('package.json', '{"main":"server.js"}')],
    sources: [src('server.js', 'app.listen(1);'), src('scripts/x.js', "require('a')")],
  })!;
  assert.equal(b.context.confident, false);
  assert.equal(b.exposureOf(pkg('a'))?.level, 'unknown');
});

check('9 Ingress auth annotations count only with a real value (auth-type: none is no login)', () => {
  const ing = (ann: string) => `apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  template:
    metadata: { labels: { app: api } }
    spec: { containers: [{ name: api, command: ["node", "src/api.js"] }] }
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec: { selector: { app: api } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public
  annotations:
    ${ann}
spec:
  rules: [{ http: { paths: [{ path: /, backend: { service: { name: api-svc } } }] } }]
`;
  const level = (ann: string) => buildContext({ lockfile: lock(['a']), contextFiles: [src('k8s.yaml', ing(ann))], sources: [src('src/api.js', "require('a')")] })!.context.entryPoints[0]!.exposure;
  assert.equal(level('alb.ingress.kubernetes.io/auth-type: none'), 'public');
  assert.equal(level('alb.ingress.kubernetes.io/auth-type: ""'), 'public');
  assert.equal(level('alb.ingress.kubernetes.io/auth-type: cognito'), 'login');
  assert.equal(level('nginx.ingress.kubernetes.io/auth-url: https://sso.example.com/check'), 'login');
});

check('10 trustDeclarations: false keeps vulnera.yml as evidence but it does not set exposure', () => {
  const run = (trust?: boolean) =>
    buildContext({
      lockfile: lock(['a']),
      contextFiles: [src('vulnera.yml', 'components:\n  api:\n    entry: src/api.js\n    exposure: offline\n'), src('docker-compose.yml', 'services:\n  api:\n    command: node src/api.js\n    ports: ["127.0.0.1:80:80"]\n')],
      sources: [src('src/api.js', "require('a')")],
      ...(trust === undefined ? {} : { trustDeclarations: trust }),
    })!;
  assert.equal(run().exposureOf(pkg('a'))?.level, 'unknown'); // default true: unknown (loopback) vs offline → more exposed wins
  const t = run(false);
  assert.equal(t.exposureOf(pkg('a'))?.level, 'unknown');
  const solo = buildContext({ lockfile: lock(['a']), contextFiles: [src('vulnera.yml', 'components:\n  api:\n    entry: src/api.js\n    exposure: offline\n')], sources: [src('src/api.js', "require('a')\nrequire('http').createServer().listen(1)")], trustDeclarations: false })!;
  assert.notEqual(solo.exposureOf(pkg('a'))?.level, 'offline');
  assert.ok(solo.context.conflicts.some((c) => c.startsWith('vulnera.yml:') && /not trusted/.test(c)));
  const trusted = buildContext({ lockfile: lock(['a']), contextFiles: [src('vulnera.yml', 'components:\n  api:\n    entry: src/api.js\n    exposure: offline\n')], sources: [src('src/api.js', "require('a')")] })!;
  assert.equal(trusted.exposureOf(pkg('a'))?.level, 'offline');
});

check('11 ReDoS: 200 KB pathological input is processed in under 300 ms', () => {
  const time = (name: string, fn: () => void) => {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    assert.ok(ms < 300, `${name} took ${Math.round(ms)} ms`);
  };
  const a = lock(['a']);
  time('from "b" + 100k spaces', () => buildContext({ lockfile: a, contextFiles: [], sources: [src('server.js', `${'from "b"'.repeat(10)}${' '.repeat(100_000)}x\napp.listen(1)`)] }));
  time('100k newlines', () => buildContext({ lockfile: a, contextFiles: [src('openapi.yaml', '\n'.repeat(100_000)), src('x.yaml', '\n'.repeat(100_000))], sources: [src('server.js', `${'\n'.repeat(100_000)}app.listen(1)`)] }));
  time('app.use( + 100k spaces', () => buildContext({ lockfile: a, contextFiles: [], sources: [src('server.js', `app.use(${' '.repeat(100_000)}\napp.listen(1)`)] }));
  time('100k slashes in a compose value', () =>
    buildContext({ lockfile: a, contextFiles: [src('docker-compose.yml', `services:\n  web:\n    command: node ${'/'.repeat(100_000)}\n    ports: ["80:80"]\n`)], sources: [src('server.js', 'app.listen(1)')] }));
  time('many short lines of imports', () => buildContext({ lockfile: a, contextFiles: [], sources: [src('server.js', `${"import x from 'y'   \n".repeat(10_000)}app.listen(1)`)] }));
  // The analysis still runs on files just under the limit, and a skipped line makes the graph incomplete.
  const big = buildContext({ lockfile: a, contextFiles: [], sources: [src('server.js', `${'x'.repeat(5000)}\napp.listen(1)`)] })!;
  assert.equal(big.context.confident, false);
});

check('12 string-literal package detection (one pass): view engine, scoped and subpath names', () => {
  const b = buildContext({
    lockfile: lock(['ejs', '@scope/pkg', 'lodash']),
    contextFiles: [],
    sources: [src('server.js', "app.set('view engine', 'ejs');\nconst x = load(\"@scope/pkg/sub\");\nconst y = load(`lodash/fp`);\napp.listen(1)")],
  })!;
  for (const n of ['ejs', '@scope/pkg', 'lodash']) assert.equal(b.exposureOf(pkg(n))?.level, 'unknown', n);
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

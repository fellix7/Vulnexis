import path from 'node:path/posix';
import { LineCounter, parseAllDocuments, type Document } from 'yaml';
import { packageRootsWithStatus, workspaceDirs } from './parse.js';
import { buildGraph, MAX_LINE, MAX_SOURCE_BYTES, propagate, RANK, type Graph, type Reach } from './reach.js';
import type { ArchitectureContext, ContextEvidence, ContextFileKind, EntryPoint, Exposure, ExposureVerdict, Package, SourceFile } from '../types.js';

// Architecture context: reads the project's own deployment and design files (docker-compose, Kubernetes,
// serverless.yml, Procfile, Dockerfile, OpenAPI, package.json, Markdown docs, an optional vulnexis.yml) to
// find each process that runs, and whether it is reachable from the internet, only from a private network,
// or not at all. Combined with the import graph (reach.ts), each vulnerable package gets an exposure level
// mapped to CISA SSVC "System Exposure". Every claim keeps the file and line it came from.

export const MAX_CONTEXT_FILES = 60;
export const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 1536 * 1024;

const DOC_NAME = /(architecture|security|threat|deploy|infra|readme|design|overview|system|network|runbook|operations)/i;

/** Which context files Vulnexis reads. Paths are relative to the project root; YAML/JSON are confirmed by content later. */
export function isContextPath(p: string): boolean {
  if (/(^|\/)(node_modules|dist|build|coverage|vendor|\.git|\.next)(\/|$)/.test(p)) return false;
  const base = p.split('/').pop()!;
  if (/^\.?vulnexis\.ya?ml$/i.test(base)) return true;
  if (/^Dockerfile(\.[\w.-]+)?$|\.Dockerfile$/.test(base) || base === 'Procfile' || base === 'package.json') return true;
  if (/\.ya?ml$/i.test(base)) return !/^(pnpm-lock|\.?eslintrc|\.?prettierrc|\.?babelrc|codecov|mkdocs|\.?gitlab-ci|dependabot|renovate)/i.test(base);
  if (/\.json$/i.test(base)) return /(openapi|swagger)/i.test(base);
  if (/\.md$/i.test(base)) return DOC_NAME.test(base) || /(^|\/)docs?\//i.test(p);
  return false;
}

export function classify(p: string, content: string): ContextFileKind | null {
  const base = p.split('/').pop()!;
  if (/^\.?vulnexis\.ya?ml$/i.test(base)) return 'vulnexis';
  if (/^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/i.test(base)) return 'compose';
  if (/^Dockerfile(\.[\w.-]+)?$|\.Dockerfile$/.test(base)) return 'dockerfile';
  if (base === 'Procfile') return 'procfile';
  if (/^serverless\.ya?ml$/i.test(base)) return 'serverless';
  if (base === 'package.json') return 'manifest';
  if (/\.md$/i.test(base)) return 'markdown';
  // [ \t]* (not \s*) so a file of blank lines cannot make the multiline scan quadratic.
  if (content.length > MAX_SOURCE_BYTES) return null;
  if (/^[ \t]*["']?(openapi|swagger)["']?[ \t]*:/m.test(content)) return 'openapi';
  if (/^[ \t]*kind[ \t]*:[ \t]*["']?(Deployment|Service|Ingress|StatefulSet|DaemonSet|CronJob|Job|Pod)\b/m.test(content)) return 'kubernetes';
  return null;
}

// ---------- small helpers ----------

interface Ctx {
  files: (SourceFile & { kind: ContextFileKind; lines: string[] })[];
  sourcePaths: Set<string>;
  base: string; // folder of the lockfile, relative to the context files' root ('' for uploads)
  trustDeclarations: boolean; // false for third-party repos: vulnexis.yml is evidence only
  cmdTexts: string[]; // every start command / script seen, to spot packages loaded from the command line (`node -r pkg`)
}

const ev = (file: { path: string; lines: string[] }, line: number): ContextEvidence => ({
  file: file.path,
  line,
  quote: (file.lines[line - 1] ?? '').trim().slice(0, 200),
});
const lineOf = (file: { lines: string[] }, re: RegExp, from = 0): number => {
  const i = file.lines.findIndex((l, n) => n >= from && re.test(l));
  return i >= 0 ? i + 1 : 1;
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function yamlDocs(file: { content: string }): { doc: Document; lc: LineCounter }[] {
  const lc = new LineCounter();
  try {
    return parseAllDocuments(file.content, { lineCounter: lc }).map((doc) => ({ doc: doc as Document, lc }));
  } catch {
    return [];
  }
}
/** Line of a YAML node (1-based), or of its parent key if the node is a plain value. */
function yLine(lc: LineCounter, doc: Document, at: (string | number)[]): number {
  const node = doc.getIn(at, true) as { range?: [number, number, number] } | undefined;
  return node?.range ? lc.linePos(node.range[0]).line : 1;
}
const asText = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(' ') : v == null ? '' : String(v));

// ---------- resolving a start command to a source file ----------

/** "node dist/server.js", "npm start", `["node","src/index.js"]` → the source file it starts, if we have it. */
function resolveCommand(ctx: Ctx, cmd: string, dirs: string[], depth = 0): { file: string | null; text: string } {
  let tokens: string[];
  try {
    const arr = JSON.parse(cmd);
    tokens = Array.isArray(arr) ? arr.map(String) : cmd.split(/\s+/);
  } catch {
    tokens = cmd.replace(/["'[\],]/g, ' ').split(/\s+/).filter(Boolean);
  }
  const toSource = (full: string): string | null => {
    const p = path.normalize(full).replace(/^\.\//, '').replace(/^\//, '');
    const rel = ctx.base && p.startsWith(ctx.base) ? p.slice(ctx.base.length) : p;
    for (const cand of [rel, rel.replace(/^(dist|build|lib|out)\//, 'src/').replace(/\.(m|c)?js$/, '.ts'), rel.replace(/^(dist|build|lib|out)\//, 'src/')]) {
      for (const ext of ['', '.js', '.ts', '.mjs', '.cjs', '/index.js', '/index.ts']) if (ctx.sourcePaths.has(cand + ext)) return cand + ext;
    }
    return null;
  };
  const scriptRun = tokens.findIndex((t) => /^(npm|yarn|pnpm|bun)$/.test(t));
  if (scriptRun >= 0 && depth < 2) {
    const rest = tokens.slice(scriptRun + 1).filter((t) => !t.startsWith('-'));
    const name = rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0];
    for (const dir of dirs) {
      const pkg = manifestIn(ctx, dir);
      const script = name && pkg?.scripts?.[name];
      if (typeof script === 'string') return resolveCommand(ctx, script, dirs, depth + 1);
    }
  }
  for (const t of tokens) {
    if (!/[./]/.test(t) || t.startsWith('-') || /^(https?:|\/usr|\/bin)/.test(t)) continue;
    for (const dir of dirs) {
      const f = toSource(path.join(dir || '.', t));
      if (f) return { file: f, text: cmd };
    }
  }
  if (tokens.some((t) => t === 'node' || t === '.')) {
    for (const dir of dirs) {
      const main = manifestIn(ctx, dir)?.main;
      if (typeof main === 'string') {
        const f = toSource(path.join(dir || '.', main));
        if (f) return { file: f, text: cmd };
      }
    }
  }
  return { file: null, text: cmd };
}

type Manifest = { main?: unknown; bin?: unknown; scripts?: Record<string, unknown> };
function manifestIn(ctx: Ctx, dir: string): Manifest | null {
  const p = path.normalize(path.join(dir || '.', 'package.json')).replace(/^\.\//, '');
  const f = ctx.files.find((x) => x.kind === 'manifest' && x.path === p);
  if (!f) return null;
  try {
    return JSON.parse(f.content) as Manifest;
  } catch {
    return null;
  }
}

function dockerfileStart(ctx: Ctx, dir: string, dockerfile?: string): { cmd: string; line: number; file: Ctx['files'][number] } | null {
  const p = path.normalize(path.join(dir || '.', dockerfile ?? 'Dockerfile')).replace(/^\.\//, '');
  const f = ctx.files.find((x) => x.kind === 'dockerfile' && x.path === p);
  if (!f) return null;
  let found: { cmd: string; line: number } | null = null;
  f.lines.forEach((l, i) => {
    const m = l.match(/^\s*(CMD|ENTRYPOINT)\s+(.+)$/i);
    if (m) found = { cmd: found && m[1]!.toUpperCase() === 'CMD' && /ENTRYPOINT/i.test(f.lines[found.line - 1]!) ? `${found.cmd} ${m[2]}` : m[2]!, line: i + 1 };
  });
  return found ? { ...(found as { cmd: string; line: number }), file: f } : null;
}

// ---------- deployment files → entry points ----------

interface Ignored {
  key: string;
  exposure: Exposure;
  how: string;
  evidence: ContextEvidence[];
}

interface Draft extends EntryPoint {
  key: string; // for merging the same component across files
}

function fromCompose(ctx: Ctx, f: Ctx['files'][number], out: Draft[]) {
  for (const { doc, lc } of yamlDocs(f)) {
    const js = doc.toJS() as { services?: Record<string, Record<string, unknown>>; networks?: Record<string, { internal?: boolean } | null> } | null;
    if (!js?.services || typeof js.services !== 'object') continue;
    const dir = path.dirname(f.path) === '.' ? '' : path.dirname(f.path);
    const loopback = (p: unknown) =>
      typeof p === 'object' && p ? /^(127\.|localhost|::1|\[::1)/.test(String((p as { host_ip?: unknown }).host_ip ?? '')) : /^(127\.|localhost|\[?::1)/.test(String(p));
    const portsOf = (svc: Record<string, unknown> | null) => (svc && Array.isArray(svc.ports) ? (svc.ports as unknown[]) : []);
    // Does any service in this file take traffic from the host (a published port, loopback included, or the host network)?
    // If so, a service with no ports of its own may sit behind it as a proxied backend.
    const takers = Object.entries(js.services).filter(([, o]) => o && typeof o === 'object' && (portsOf(o).length > 0 || o.network_mode === 'host')).map(([n]) => n);
    for (const [name, svc] of Object.entries(js.services)) {
      if (!svc || typeof svc !== 'object') continue;
      const ports = portsOf(svc);
      const published = ports.filter((p) => !loopback(p));
      const local = ports.filter(loopback);
      const nets = Array.isArray(svc.networks) ? svc.networks.map(String) : svc.networks && typeof svc.networks === 'object' ? Object.keys(svc.networks) : [];
      const allInternal = nets.length > 0 && nets.every((n) => js.networks?.[n]?.internal === true);
      const hostNet = svc.network_mode === 'host';
      const proxies = takers.filter((n) => n !== name);
      let exposure: Exposure;
      let how: string;
      let line: number;
      if (allInternal) {
        exposure = 'internal';
        line = yLine(lc, doc, ['services', name, 'networks']);
        how = `${f.path}: "${name}" is only on internal networks (${nets.join(', ')})`;
      } else if (published.length || hostNet) {
        exposure = 'public';
        line = published.length ? yLine(lc, doc, ['services', name, 'ports']) : yLine(lc, doc, ['services', name]);
        const first = published[0];
        how = hostNet && !published.length ? `${f.path}: "${name}" uses the host network` : `${f.path}: "${name}" publishes port ${String(typeof first === 'object' ? (first as { published?: unknown }).published : first)}`;
      } else if (local.length) {
        exposure = 'unknown';
        line = yLine(lc, doc, ['services', name, 'ports']);
        how = `${f.path}: "${name}" binds only to localhost (${String(typeof local[0] === 'object' ? (local[0] as { host_ip?: unknown }).host_ip : local[0])}); a reverse proxy on the host may forward public traffic to it, so exposure is unknown`;
      } else if (proxies.length) {
        exposure = 'unknown';
        line = yLine(lc, doc, ['services', name]);
        how = `${f.path}: "${name}" publishes no ports itself, but ${proxies.map((n) => `"${n}"`).join(', ')} in the same file does, so it may be a proxied backend; exposure is unknown`;
      } else {
        exposure = 'internal';
        line = yLine(lc, doc, ['services', name]);
        how = `${f.path}: "${name}" publishes no ports and no service in this file publishes any (reachable only by other services)`;
      }
      const build = svc.build;
      const ctxDir = path.normalize(path.join(dir || '.', typeof build === 'string' ? build : typeof build === 'object' && build ? String((build as { context?: unknown }).context ?? '.') : '.')).replace(/^\.$/, '');
      const evidence = [ev(f, line)];
      if (allInternal) for (const n of nets) evidence.push(ev(f, yLine(lc, doc, ['networks', n, 'internal'])));
      let start = { file: null as string | null, text: '' };
      const cmd = asText(svc.command) || asText(svc.entrypoint);
      if (cmd) ctx.cmdTexts.push(cmd);
      if (cmd) {
        start = resolveCommand(ctx, cmd, [ctxDir, dir, '']);
        evidence.push(ev(f, yLine(lc, doc, ['services', name, svc.command ? 'command' : 'entrypoint'])));
      } else if (build) {
        const df = dockerfileStart(ctx, ctxDir, typeof build === 'object' ? ((build as { dockerfile?: string }).dockerfile ?? undefined) : undefined);
        if (df) {
          start = resolveCommand(ctx, df.cmd, [ctxDir, '']);
          evidence.push(ev(df.file, df.line));
        }
      }
      out.push({ key: name, component: name, file: start.file, exposure, how, evidence });
    }
  }
}

function fromKubernetes(f: Ctx['files'][number], k8s: K8sState, cmdTexts: string[]) {
  for (const { doc, lc } of yamlDocs(f)) {
    const o = doc.toJS() as Record<string, any> | null;
    if (!o || typeof o.kind !== 'string') continue;
    const name = String(o.metadata?.name ?? o.kind);
    const line = yLine(lc, doc, ['kind']);
    if (/^(Deployment|StatefulSet|DaemonSet|Pod|Job|CronJob)$/.test(o.kind)) {
      const tpl = o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template : o.kind === 'Pod' ? o : o.spec?.template;
      const containers: any[] = (o.kind === 'Pod' ? o.spec?.containers : tpl?.spec?.containers) ?? [];
      const cmd = containers.map((c) => [asText(c.command), asText(c.args)].join(' ').trim()).find(Boolean) ?? '';
      if (cmd) cmdTexts.push(cmd);
      k8s.workloads.push({ name, kind: o.kind, labels: tpl?.metadata?.labels ?? o.metadata?.labels ?? {}, cmd, file: f, line });
    } else if (o.kind === 'Service') {
      k8s.services.push({ name, type: String(o.spec?.type ?? 'ClusterIP'), selector: o.spec?.selector ?? {}, file: f, line: yLine(lc, doc, o.spec?.type ? ['spec', 'type'] : ['kind']) });
    } else if (o.kind === 'Ingress') {
      const backends = new Set<string>();
      const walk = (v: any) => {
        if (!v || typeof v !== 'object') return;
        if (typeof v.serviceName === 'string') backends.add(v.serviceName);
        if (typeof v.service?.name === 'string') backends.add(v.service.name);
        for (const x of Object.values(v)) walk(x);
      };
      walk(o.spec);
      // An auth annotation counts only with a real value: `auth-type: none` (or empty/false) is no login wall.
      const annotations: Record<string, unknown> = o.metadata?.annotations ?? {};
      const ann = Object.keys(annotations).find((k) => {
        if (!/auth-(url|type|signin)|oauth|authorization/i.test(k)) return false;
        const v = String(annotations[k] ?? '').trim().toLowerCase();
        return v !== '' && !['none', 'false', 'off', 'no', '0', 'null', 'disabled'].includes(v);
      });
      k8s.ingresses.push({ name, backends, auth: ann ?? null, file: f, line });
    }
  }
}

interface K8sState {
  workloads: { name: string; kind: string; labels: Record<string, string>; cmd: string; file: Ctx['files'][number]; line: number }[];
  services: { name: string; type: string; selector: Record<string, string>; file: Ctx['files'][number]; line: number }[];
  ingresses: { name: string; backends: Set<string>; auth: string | null; file: Ctx['files'][number]; line: number }[];
}

function k8sEntries(ctx: Ctx, k8s: K8sState, out: Draft[]) {
  const soleDockerfile = ctx.files.filter((x) => x.kind === 'dockerfile');
  for (const w of k8s.workloads) {
    const svcs = k8s.services.filter((s) => Object.keys(s.selector).length > 0 && Object.entries(s.selector).every(([k, v]) => w.labels[k] === v));
    const evidence = [ev(w.file, w.line)];
    let exposure: Exposure;
    let how: string;
    const lb = svcs.find((s) => s.type === 'LoadBalancer' || s.type === 'NodePort');
    const ing = k8s.ingresses.find((i) => svcs.some((s) => i.backends.has(s.name)));
    if (w.kind === 'CronJob' || w.kind === 'Job') {
      exposure = 'offline';
      how = `${w.file.path}: "${w.name}" is a ${w.kind} (runs on a schedule, takes no requests)`;
    } else if (ing) {
      exposure = ing.auth ? 'login' : 'public';
      how = `${ing.file.path}: Ingress "${ing.name}" routes internet traffic to it${ing.auth ? ` behind ${ing.auth}` : ''}`;
      evidence.push(ev(ing.file, ing.line));
    } else if (lb) {
      exposure = 'public';
      how = `${lb.file.path}: Service "${lb.name}" is type ${lb.type}`;
      evidence.push(ev(lb.file, lb.line));
    } else {
      exposure = 'internal';
      how = svcs[0] ? `${svcs[0].file.path}: Service "${svcs[0].name}" is ${svcs[0].type} only (inside the cluster)` : `${w.file.path}: no Service or Ingress points at "${w.name}"`;
      if (svcs[0]) evidence.push(ev(svcs[0].file, svcs[0].line));
    }
    let start = w.cmd ? resolveCommand(ctx, w.cmd, ['']) : { file: null as string | null, text: '' };
    if (!start.file && soleDockerfile.length === 1) {
      const df = dockerfileStart(ctx, path.dirname(soleDockerfile[0]!.path).replace(/^\.$/, ''));
      if (df) {
        start = resolveCommand(ctx, df.cmd, [path.dirname(df.file.path).replace(/^\.$/, ''), '']);
        evidence.push(ev(df.file, df.line));
      }
    }
    out.push({ key: w.name, component: w.name, file: start.file, exposure, how, evidence });
  }
}

function fromServerless(ctx: Ctx, f: Ctx['files'][number], out: Draft[]) {
  for (const { doc, lc } of yamlDocs(f)) {
    const fns = (doc.toJS() as { functions?: Record<string, { handler?: string; events?: Record<string, any>[] }> } | null)?.functions;
    if (!fns) continue;
    const dir = path.dirname(f.path).replace(/^\.$/, '');
    for (const [name, fn] of Object.entries(fns)) {
      const events = fn?.events ?? [];
      const kinds = events.flatMap((e) => Object.keys(e ?? {}));
      const http = events.find((e) => e && (e.http || e.httpApi || e.alb || e.websocket));
      const authorized = http && [http.http, http.httpApi, http.websocket].some((h) => h && typeof h === 'object' && h.authorizer);
      const exposure: Exposure = http ? (authorized ? 'login' : 'public') : kinds.some((k) => k === 'schedule') ? 'offline' : 'internal';
      const handler = String(fn?.handler ?? '').replace(/\.[\w$]+$/, '');
      const start = handler ? resolveCommand(ctx, handler, [dir, '']) : { file: null, text: '' };
      out.push({
        key: name,
        component: name,
        file: start.file,
        exposure,
        how: `${f.path}: function "${name}" ${http ? `has an HTTP event${authorized ? ' with an authorizer' : ''}` : kinds.length ? `is triggered by ${kinds.join(', ')}` : 'has no events'}`,
        evidence: [ev(f, yLine(lc, doc, ['functions', name]))],
      });
    }
  }
}

function fromProcfile(ctx: Ctx, f: Ctx['files'][number], out: Draft[]) {
  const dir = path.dirname(f.path).replace(/^\.$/, '');
  f.lines.forEach((l, i) => {
    const m = l.match(/^([\w-]+)\s*:\s*(.+)$/);
    if (!m) return;
    const type = m[1]!;
    const exposure: Exposure = type === 'web' ? 'public' : /^(release|clock|cron|scheduler)$/.test(type) ? 'offline' : 'internal';
    out.push({
      key: type,
      component: type,
      file: resolveCommand(ctx, m[2]!, [dir, '']).file,
      exposure,
      how: `${f.path}: "${type}" process${type === 'web' ? ' receives the public HTTP traffic' : ' receives no HTTP traffic'}`,
      evidence: [ev(f, i + 1)],
    });
  });
}

/** vulnexis.yml: the team's own declaration. `components: { web: { entry, exposure, auth } }` or a list of them. */
function fromDeclared(ctx: Ctx, f: Ctx['files'][number], out: Draft[], conflicts: string[], ignored: Ignored[]) {
  for (const { doc, lc } of yamlDocs(f)) {
    const raw = (doc.toJS() as { components?: unknown } | null)?.components;
    const list: [string, Record<string, unknown>, (string | number)[]][] = Array.isArray(raw)
      ? raw.map((c, i) => [String((c as { name?: unknown })?.name ?? `component ${i + 1}`), c as Record<string, unknown>, ['components', i]])
      : raw && typeof raw === 'object'
        ? Object.entries(raw as Record<string, Record<string, unknown>>).map(([k, v]) => [k, v ?? {}, ['components', k]])
        : [];
    for (const [name, c, at] of list) {
      const word = String(c.exposure ?? '').toLowerCase();
      let exposure: Exposure | null =
        /^(public|internet|open|internet[- ]facing)$/.test(word) ? 'public'
        : /^(internal|private|vpc|vpn|intranet|controlled)$/.test(word) ? 'internal'
        : /^(offline|none|cli|cron|batch|small)$/.test(word) ? 'offline'
        : /^(login|auth|authenticated)$/.test(word) ? 'login'
        : null;
      if (!exposure) {
        if (word) conflicts.push(`${f.path}:${yLine(lc, doc, [...at, 'exposure'])} uses an unknown exposure "${word}" (use public, internal, login or offline).`);
        continue;
      }
      if (exposure === 'public' && /^(required|jwt|login|yes|true)$/i.test(String(c.auth ?? ''))) exposure = 'login';
      const entry = typeof c.entry === 'string' ? resolveCommand(ctx, c.entry, ['']).file : null;
      const how = `${f.path}: declared ${exposure}${c.note ? ` (${String(c.note).slice(0, 80)})` : ''}`;
      const evidence = [ev(f, yLine(lc, doc, [...at, 'exposure']))];
      if (!ctx.trustDeclarations) {
        ignored.push({ key: name, exposure, how, evidence });
        continue;
      }
      out.push({ key: name, component: name, file: entry, exposure, how, evidence });
    }
  }
}

// ---------- Markdown docs ----------

const MD = {
  internal: /\b(internal[- ]only|internal network|private( \w+)? (network|subnet|vpc|cluster)|not (publicly )?(exposed|reachable|accessible)|never exposed|no public (port|access|endpoint|ingress)|intranet|inside (the |our )?(vpc|vpn|private network|cluster)|behind (a |the |our )?(vpn|firewall)|only reachable (from|inside|within)|localhost only|not internet[- ]facing)\b/i,
  login: /\b(requires? (a |an |the )?(valid )?(owner'?s? )?(login|log-in|authentication|jwt|bearer token|access token|sign[- ]in)|behind (the |a )?(login|auth\w*|sso)|(authenticated|logged[- ]in|signed[- ]in) (users|requests|owners|admins) only|admin[- ]only|owner[- ]only|jwt[- ]protected|protected by (a |the )?(jwt|auth\w*|login|sso|oauth))\b/i,
  offline: /\b(cron( job)?|nightly|scheduled (job|task)|batch job|cli tool|command[- ]line tool|one[- ]off script|runs? offline|no (inbound|network) (access|traffic|port))\b/i,
  public: /\b(public(ly)?[- ](facing|accessible|exposed|reachable)|internet[- ]facing|exposed to the (public )?internet|open to the (public|internet)|public (api|website|endpoint|web ?site)|anyone (can|on the internet))\b/i,
};

interface DocClaim {
  exposure: Exposure;
  evidence: ContextEvidence;
  subject: string; // component name or route prefix it mentions
}

// "This service is only reachable inside the office VPN": a claim about the whole project.
const PROJECT = /\b(this|the|our) (app|application|service|server|backend|api|tool|project|dashboard|system)\b/i;

function docClaims(f: Ctx['files'][number], subjects: string[], projectLevel: boolean): DocClaim[] {
  const out: DocClaim[] = [];
  let fence = false;
  f.lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence || !l.trim() || l.length > MAX_LINE) return;
    const exposure: Exposure | null = MD.internal.test(l) ? 'internal' : MD.login.test(l) ? 'login' : MD.offline.test(l) ? 'offline' : MD.public.test(l) ? 'public' : null;
    if (!exposure) return;
    if (projectLevel && PROJECT.test(l)) out.push({ exposure, evidence: ev(f, i + 1), subject: '*' });
    for (const s of subjects) {
      const re = s.startsWith('/') ? new RegExp(`(^|[\\s\`(])${esc(s)}(?![\\w-])`) : new RegExp(`(^|[^\\w-])${esc(s)}(?![\\w-])`, 'i');
      if (re.test(l)) out.push({ exposure, evidence: ev(f, i + 1), subject: s });
    }
  });
  return out;
}

// ---------- OpenAPI: which routes the contract says need a token ----------

function openApiSecured(f: Ctx['files'][number]): { prefixes: Map<string, ContextEvidence>; jwt: boolean } {
  const prefixes = new Map<string, ContextEvidence>();
  let jwt = false;
  for (const { doc, lc } of yamlDocs(f)) {
    const o = doc.toJS() as Record<string, any> | null;
    if (!o?.paths) continue;
    const schemes = o.components?.securitySchemes ?? o.securityDefinitions ?? {};
    jwt = Object.values(schemes).some((s: any) => /jwt/i.test(String(s?.bearerFormat ?? '')) || s?.scheme === 'bearer');
    const globalSec = Array.isArray(o.security) && o.security.length > 0;
    for (const [p, ops] of Object.entries(o.paths as Record<string, Record<string, any>>)) {
      const methods = Object.entries(ops ?? {}).filter(([m]) => /^(get|post|put|patch|delete|head|options)$/.test(m));
      if (!methods.length) continue;
      const secured = methods.every(([, op]) => (Array.isArray(op?.security) ? op.security.length > 0 : globalSec));
      const prefix = `/${p.split('/').filter(Boolean)[0] ?? ''}`;
      if (secured && !prefixes.has(prefix)) prefixes.set(prefix, ev(f, yLine(lc, doc, ['paths', p])));
      if (!secured) prefixes.set(prefix, { file: '', line: 0, quote: '' }); // any public path under the prefix voids it
    }
  }
  for (const [k, v] of prefixes) if (!v.file) prefixes.delete(k);
  return { prefixes, jwt };
}

// ---------- the whole context ----------

export interface BuiltContext {
  context: ArchitectureContext;
  exposureOf: (pkg: Package) => ExposureVerdict | undefined;
}

const SSVC: Record<Exposure, ExposureVerdict['ssvc']> = { public: 'open', unknown: 'open', login: 'controlled', internal: 'controlled', offline: 'small', unreached: 'small' };

export function buildContext(input: {
  lockfile: unknown;
  sources: SourceFile[];
  contextFiles: SourceFile[];
  base?: string;
  truncated?: boolean; // some source files were not read (limits), so "unreached" cannot be claimed
  /** Default true. Set false for a repository you do not control: its vulnexis.yml is then shown as evidence only. */
  trustDeclarations?: boolean;
}): BuiltContext | null {
  const conflicts: string[] = [];
  let skipped = false;
  const files = input.contextFiles
    .map((s) => {
      if (s.content.length > MAX_SOURCE_BYTES) {
        skipped = true;
        conflicts.push(`${s.path} is over ${MAX_SOURCE_BYTES / 1024} KB and was not analysed. Exposure is unknown where it matters.`);
        return null;
      }
      const kind = classify(s.path, s.content);
      if (!kind) return null;
      // Lines longer than MAX_LINE are not analysed (hostile or minified input), which keeps every regex linear.
      return { ...s, kind, lines: s.content.split(/\r?\n/).map((l) => (l.length > MAX_LINE ? '' : l)) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!files.length && !input.sources.length) return null;

  const ctx: Ctx = { files, sourcePaths: new Set(input.sources.map((s) => s.path)), base: input.base ?? '', trustDeclarations: input.trustDeclarations !== false, cmdTexts: [] };
  for (const f of files) {
    if (f.kind === 'manifest') {
      try {
        const scripts = (JSON.parse(f.content) as Manifest).scripts;
        if (scripts && typeof scripts === 'object') ctx.cmdTexts.push(...Object.values(scripts).filter((v): v is string => typeof v === 'string'));
      } catch {
        /* unreadable manifest: no scripts to scan */
      }
    } else if (f.kind === 'procfile' || f.kind === 'dockerfile') ctx.cmdTexts.push(...f.lines);
  }
  const ignored: Ignored[] = [];
  const drafts: Draft[] = [];
  const k8s: K8sState = { workloads: [], services: [], ingresses: [] };
  for (const f of files) {
    if (f.kind === 'compose') fromCompose(ctx, f, drafts);
    else if (f.kind === 'kubernetes') fromKubernetes(f, k8s, ctx.cmdTexts);
    else if (f.kind === 'serverless') fromServerless(ctx, f, drafts);
    else if (f.kind === 'procfile') fromProcfile(ctx, f, drafts);
  }
  k8sEntries(ctx, k8s, drafts);
  for (const f of files) if (f.kind === 'vulnexis') fromDeclared(ctx, f, drafts, conflicts, ignored);

  // Merge the same component seen in several files: the more exposed reading wins, and disagreements are noted.
  const merged = new Map<string, Draft>();
  for (const d of drafts) {
    const cur = merged.get(d.key);
    if (!cur) {
      merged.set(d.key, { ...d, evidence: [...d.evidence] });
      continue;
    }
    if (cur.exposure !== d.exposure) conflicts.push(`"${d.key}": ${cur.how} says ${cur.exposure}, but ${d.how} says ${d.exposure}. Using the more exposed reading.`);
    if (RANK[d.exposure] > RANK[cur.exposure]) Object.assign(cur, { exposure: d.exposure, how: d.how });
    cur.file ??= d.file;
    cur.evidence.push(...d.evidence);
  }
  let entries = [...merged.values()];
  // Declarations in a repository we do not control (trustDeclarations: false): evidence only, never exposure.
  for (const d of ignored) {
    const e = entries.find((x) => x.key === d.key);
    if (e) e.evidence.push(...d.evidence);
    conflicts.push(`${d.evidence[0]!.file}:${d.evidence[0]!.line} declares "${d.key}" as ${d.exposure}, but declarations in a scanned third-party repository are not trusted (its author controls them). Exposure comes from the deployment files and code only.`);
  }

  // No deployment files (or none that point at code we have): fall back to package.json and servers in the code.
  const rootsStatus = packageRootsWithStatus(input.lockfile);
  const roots = rootsStatus.roots;
  const graph: Graph | null = input.sources.length ? buildGraph(input.sources, new Set([...roots.values()].flatMap((s) => [...s])), workspaceDirs(input.lockfile)) : null;
  const deployed = entries.some((e) => e.file);
  if (!deployed) {
    const pkg = manifestIn(ctx, ctx.base.replace(/\/$/, '')) ?? manifestIn(ctx, '');
    const manifestFile = files.find((x) => x.kind === 'manifest' && (x.path === `${ctx.base}package.json` || x.path === 'package.json'));
    const seen = new Set(entries.map((e) => e.file));
    const add = (component: string, file: string | null, exposure: Exposure, how: string, evidence: ContextEvidence[]) => {
      if (file && seen.has(file)) return;
      seen.add(file);
      entries.push({ key: component, component, file, exposure, how, evidence });
    };
    if (pkg && manifestFile) {
      const start = typeof pkg.scripts?.start === 'string' ? resolveCommand(ctx, pkg.scripts.start, [ctx.base.replace(/\/$/, ''), '']).file : null;
      const main = typeof pkg.main === 'string' ? resolveCommand(ctx, `node ${pkg.main}`, [ctx.base.replace(/\/$/, ''), '']).file : null;
      const file = start ?? main;
      if (file) add('app', file, 'unknown', `${manifestFile.path}: "${start ? 'start' : 'main'}" runs ${file}; no deployment file says where it is exposed`, [ev(manifestFile, lineOf(manifestFile, start ? /"start"\s*:/ : /"main"\s*:/))]);
      const bins = typeof pkg.bin === 'string' ? { cli: pkg.bin } : pkg.bin && typeof pkg.bin === 'object' ? (pkg.bin as Record<string, string>) : {};
      for (const [name, rel] of Object.entries(bins)) {
        add(name, resolveCommand(ctx, `node ${rel}`, [ctx.base.replace(/\/$/, ''), '']).file, 'offline', `${manifestFile.path}: "${name}" is a command-line tool (bin)`, [ev(manifestFile, lineOf(manifestFile, /"bin"\s*:/))]);
      }
    }
    if (graph) {
      for (const f of graph.files.values()) {
        if (f.listens !== null) add(f.path, f.path, 'unknown', `${f.path}:${f.listens} starts a server; no deployment file says where it is exposed`, [{ file: f.path, line: f.listens, quote: f.lines[f.listens - 1]!.trim().slice(0, 200) }]);
      }
    }
  }

  // Docs: claims about components and route prefixes. They never lower what config or code shows.
  const prefixes = graph ? [...new Set([...graph.files.values()].flatMap((f) => f.mounts.map((m) => m.prefix)).filter((p) => p.length > 1))] : [];
  const subjects = [...new Set([...entries.map((e) => e.component), ...entries.flatMap((e) => (e.file ? [e.file.split('/').pop()!.replace(/\.\w+$/, '')] : [])).filter((s) => !/^(index|server|main|app)$/.test(s)), ...prefixes])];
  const onlyUnknown = entries.length > 0 && entries.every((e) => e.exposure === 'unknown');
  const claims = files.filter((f) => f.kind === 'markdown').flatMap((f) => docClaims(f, subjects, onlyUnknown && f.path.split('/').length <= ctx.base.split('/').length));
  const stem = (file: string | null) => (file ? file.split('/').pop()!.replace(/\.\w+$/, '') : null);
  for (const e of entries) {
    const mine = claims.filter((c) => c.subject === e.component || c.subject === stem(e.file) || (c.subject === '*' && onlyUnknown));
    for (const c of mine) {
      // Markdown NEVER changes exposure: prose is easy to get wrong (or to plant). It stays as evidence, and a doc
      // that claims something safer than config/code (or than "unknown") is reported as a conflict.
      if (RANK[e.exposure] >= RANK.unknown && RANK[c.exposure] < RANK.unknown && !(c.exposure === 'login' && e.exposure === 'public')) {
        conflicts.push(`${c.evidence.file}:${c.evidence.line} describes "${e.component}" as ${c.exposure}, but ${e.how}. Docs do not change exposure; using the more exposed reading.`);
      }
      if (!e.evidence.some((x) => x.file === c.evidence.file && x.line === c.evidence.line)) e.evidence.push(c.evidence);
    }
  }

  // Code: auth-guarded mounts, cross-checked with what docs and the OpenAPI contract say.
  const protectedMounts: ArchitectureContext['protectedMounts'] = [];
  const secured = new Map<string, ContextEvidence>();
  for (const f of files) if (f.kind === 'openapi') for (const [k, v] of openApiSecured(f).prefixes) secured.set(k, v);
  if (graph) {
    for (const f of graph.files.values()) {
      for (const m of f.mounts) {
        if (m.guard) protectedMounts.push({ file: f.path, line: m.guard.line, prefix: m.prefix || '/', guard: m.guard.name });
        else if (m.prefix) {
          const said = claims.find((c) => c.subject === m.prefix && c.exposure === 'login') ?? null;
          const spec = secured.get(m.prefix);
          for (const src of [said?.evidence, spec].filter(Boolean) as ContextEvidence[]) {
            conflicts.push(`${src.file}:${src.line} says ${m.prefix} needs a login, but ${f.path}:${m.line} mounts it with no auth middleware. Treated as public until the code checks a token.`);
          }
        }
      }
    }
  }

  // Walk the code from every entry point.
  // Skipped files, or a dependency tree too large to analyse in full: never claim "not loaded".
  const truncated = Boolean(input.truncated) || !rootsStatus.complete;
  const reach: Map<string, Reach> = graph ? propagate(graph, entries.filter((e) => e.file).map((e) => ({ file: e.file!, exposure: e.exposure, component: e.component }))) : new Map();
  // "Not loaded by any entry point" needs a complete picture: every component linked to its start file,
  // every import followable, no file-based routing, no skipped files.
  const confident =
    Boolean(graph) && !truncated && entries.length > 0 && entries.every((e) => e.file && graph!.files.has(e.file)) && graph!.dynamic.length === 0 && !frameworkRouted(input.lockfile);

  // A login wall only keeps attackers out if they cannot simply sign up.
  let openSignup: ContextEvidence | undefined;
  for (const [file, r] of reach) {
    if (RANK[r.level] < RANK.unknown) continue;
    const f = graph!.files.get(file)!;
    const i = f.lines.findIndex((l) => /\.(post|put|all)[ \t]*\([ \t]*['"`][^'"`]*(register|signup|sign-up|sign_up|join|create-account)/i.test(l));
    if (i >= 0) {
      openSignup = lineEv(graph!, file, i + 1);
      break;
    }
  }

  const entryByComponent = new Map(entries.map((e) => [e.component, e]));

  const context: ArchitectureContext = {
    files: files.map((f) => ({ path: f.path, kind: f.kind })),
    entryPoints: entries.map(({ key: _k, ...e }) => e),
    protectedMounts,
    conflicts: [...new Set(conflicts)],
    ...(openSignup ? { openSignup } : {}),
    confident,
    reachedFiles: reach.size,
  };

  const exposureOf = (pkg: Package): ExposureVerdict | undefined => {
    if (pkg.dev || !entries.length) return undefined;
    const names = new Set(roots.get(`${pkg.name}@${pkg.version}`) ?? []);
    names.add(pkg.path[0] ?? pkg.name);
    if (pkg.direct) names.add(pkg.name);

    if (!graph) {
      // Lockfile only: every component may load every package, so the most exposed one counts.
      const top = entries.reduce((a, b) => (RANK[b.exposure] > RANK[a.exposure] ? b : a));
      return verdict(top.exposure, [top.component], `${top.how}. Without the source code every component is assumed to load it.`, top.evidence.slice(0, 2));
    }

    // Every file that loads the package. A file no entry point reaches only counts as "unreached" if it is clearly
    // not production code (tests, scripts, configs...). Browser code, preloads and workers could run, so they stay unknown.
    let level: Exposure | null = null;
    let best: { reach?: Reach; file: string; line: number } | null = null;
    for (const f of graph.files.values()) {
      for (const n of names) {
        const line = f.packages.get(n);
        if (!line) continue;
        const r = reach.get(f.path);
        const l: Exposure = r ? r.level : isNonProduction(f.path) ? 'unreached' : 'unknown';
        if (level === null || RANK[l] > RANK[level]) {
          level = l;
          best = { reach: r, file: f.path, line };
        }
      }
    }
    if (level === null) return verdict('unknown', [], 'No source file that was read imports it, but it may still be loaded by a preload flag, a framework or code that was not read. Treated as internet-facing.', []);
    if (level === 'unreached') {
      if (!confident) return verdict('unknown', [], 'No entry point loads it in the code that was read, but the code could not be followed completely (dynamic imports, file-based routing or skipped files). Treated as internet-facing.', []);
      const cmd = mentionedInCommands(ctx.cmdTexts, names);
      if (cmd) return verdict('unknown', [], `It is only imported by non-production files, but "${cmd.name}" appears in a start command or script (${cmd.text.slice(0, 80)}), so it may be preloaded. Treated as internet-facing.`, []);
      return verdict('unreached', [], `No deployed entry point loads this package. It is only imported by ${best!.file}, which no entry point runs and which is a test, script or config file.`, [lineEv(graph, best!.file, best!.line)]);
    }
    if (level === 'unknown' && !best!.reach) {
      return verdict('unknown', [], `Imported by ${best!.file}, which no entry point was found to run but which is not clearly a test or dev script (it may be browser code, a preload or a worker). Treated as internet-facing.`, [lineEv(graph, best!.file, best!.line)]);
    }
    const via = [...(best!.reach?.via ?? [])];
    const entry = entryByComponent.get(via[0] ?? '');
    const evidence = [lineEv(graph, best!.file, best!.line), ...(best!.reach?.guard ? [best!.reach.guard] : []), ...(entry?.evidence.slice(0, 1) ?? [])];
    const list = via.join(', ');
    const reason =
      level === 'public' ? `Loaded by "${list}", which is reachable from the internet (${entry?.how}).`
      : level === 'login' ? best!.reach?.guard ? `Only loaded by code behind login (${best!.reach.guard.file}:${best!.reach.guard.line}); an attacker needs a valid account or token first.` : `Only loaded by "${list}", which requires login (${entry?.how}).`
      : level === 'internal' ? `Only loaded by "${list}", which runs on a private network (${entry?.how}).`
      : level === 'offline' ? `Only loaded by "${list}", which takes no network requests (${entry?.how}).`
      : `Loaded by "${list}", but nothing says where it is deployed (${entry?.how}). Treated as internet-facing.`;
    const v = verdict(level, via, reason, evidence);
    if (level === 'login' && openSignup) {
      v.openSignup = openSignup;
      v.reason += ` But anyone can create an account (${openSignup.file}:${openSignup.line}), so this does not lower the priority.`;
    }
    return v;
  };

  return { context, exposureOf };
}

function verdict(level: Exposure, via: string[], reason: string, evidence: ContextEvidence[]): ExposureVerdict {
  const v: ExposureVerdict = { level, ssvc: SSVC[level], via, reason, evidence: dedupe(evidence).slice(0, 4), lowered: false };
  if (level === 'unreached') v.vex = 'vulnerable_code_not_in_execute_path';
  return v;
}
const dedupe = (e: ContextEvidence[]) => e.filter((x, i) => e.findIndex((y) => y.file === x.file && y.line === x.line) === i);
const lineEv = (g: Graph, file: string, line: number): ContextEvidence => ({ file, line, quote: (g.files.get(file)?.lines[line - 1] ?? '').trim().slice(0, 200) });

/** Files that are clearly not production code: tests, dev scripts, seeds, migrations, fixtures, mocks, examples, docs, configs. */
export function isNonProduction(p: string): boolean {
  if (/(^|\/)(tests?|__tests__|__mocks__|spec|scripts|tools|seeds?|migrations?|fixtures?|examples?|docs?|e2e)\//i.test(p)) return true;
  const base = p.split('/').pop()!;
  return /\.(test|spec)\.[^/]+$/.test(base) || /\.config\.[^/]+$/.test(base) || /^\.?[\w-]+rc(\.[cm]?[jt]s)?$/.test(base);
}

/** Does a start command / npm script / Procfile / Dockerfile line name one of these packages (`node -r pkg`, `npx pkg`)? */
function mentionedInCommands(texts: string[], names: Set<string>): { name: string; text: string } | null {
  const word = /[\w-]/;
  for (const text of texts) {
    if (text.length > 20000) continue;
    for (const name of names) {
      for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
        const before = text[i - 1];
        const after = text[i + name.length];
        if ((before === undefined || !word.test(before)) && (after === undefined || !word.test(after))) return { name, text };
      }
    }
  }
  return null;
}

/** Frameworks that route by file name: their pages are entry points the import graph cannot see. Checks the root and every workspace. */
function frameworkRouted(lock: unknown): boolean {
  const pk = (lock as { packages?: Record<string, Record<string, Record<string, string> | undefined>> })?.packages ?? {};
  const deps = new Set<string>();
  for (const [key, e] of Object.entries(pk)) {
    if (key.includes('node_modules/') || !e) continue; // '' (root) and workspace folders only
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) for (const n of Object.keys(e[field] ?? {})) deps.add(n);
  }
  return ['next', 'nuxt', '@remix-run/node', '@sveltejs/kit', 'gatsby', 'astro', 'sails', 'strapi', '@strapi/strapi', 'meteor-node-stubs', '@adonisjs/core', 'loopback'].some((n) => deps.has(n));
}

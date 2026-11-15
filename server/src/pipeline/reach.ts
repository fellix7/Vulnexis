import path from 'node:path/posix';
import type { ContextEvidence, Exposure, SourceFile } from '../types.js';

// Code reachability: which source files run from which entry point, and which of them sit behind an auth
// middleware. Plain text analysis of require/import statements and Express-style `.use()` mounts; nothing
// is executed. The result answers "if this package is vulnerable, can an attacker's request reach the code
// that loads it?".

/** Most exposed first. "unknown" ranks just below "public": without context we assume exposure (CISA SSVC default). */
export const RANK: Record<Exposure, number> = { unreached: 0, offline: 1, internal: 2, login: 3, unknown: 4, public: 5 };
export const maxExposure = (a: Exposure, b: Exposure): Exposure => (RANK[a] >= RANK[b] ? a : b);
export const minExposure = (a: Exposure, b: Exposure): Exposure => (RANK[a] <= RANK[b] ? a : b);

const RESOLVE_EXT = ['', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '/index.js', '/index.ts', '/index.tsx', '/index.jsx', '/index.mjs', '/index.cjs'];

// Callee names that mean "the request must be authenticated first". Matched against the start of a
// middleware argument, e.g. `requireOwner`, `passport.authenticate('jwt')`, `expressjwt({...})`.
const GUARD =
  /^(passport\.authenticate|keycloak\.protect|express[jJ]wt|jwt|basicAuth|requiresAuth|protect(ed)?|authenticate\w*|authorize\w*|auth|isAdmin|isLoggedIn|loggedIn|withAuth)$|^(require|ensure|verify|check|is|must|only)(Auth|Login|LoggedIn|Logged|User|Owner|Admin|Role|Jwt|JWT|Token|Session|Signed)\w*$|[a-z](Auth|Guard|Jwt|JWT)$/;
// A file that declares routes (so mounting it exposes its handlers). Tested per line with [ \t]* so it stays linear.
const ROUTES = /\b(?:express\.)?Router[ \t]*\(|\.(?:get|post|put|patch|delete|all|route)[ \t]*\([ \t]*['"`]/;
// A route handler declared with a string path. Used to tell whether a guard comes before or after the routes.
const ROUTE_DECL = /\.(?:get|post|put|patch|delete|all|route)[ \t]*\([ \t]*['"`]/;

/** Limits that keep the regex work linear on hostile input. Longer lines/files are not analysed (and make the graph incomplete). */
export const MAX_LINE = 2000;
export const MAX_SOURCE_BYTES = 400 * 1024;

// Middleware that looks like auth by name but is not a login wall (optional auth, rate limits, CORS, logging, sessions...).
// `log` keeps login/logged-in names; `session` keeps requireSession/ensureSession.
const NOT_GUARD = /optional|maybe|soft|public|anon|throttl|rate|limit|cors|helmet|log(?!in|ged)|metric|csrf/i;
const NOT_GUARD_ARG = /\b(?:authRequired|required|credentialsRequired)[ \t]*:[ \t]*false\b/;
const SESSION_GUARD = /(?:require|ensure|verify|check|must|only)\w*session|session\w*(?:require|ensure)/i;

export interface Mount {
  line: number;
  prefix: string;
  target: string;
  guard: { line: number; name: string } | null;
}

export interface FileInfo {
  path: string;
  lines: string[];
  edges: Map<string, number>; // resolved relative import → line
  packages: Map<string, number>; // npm package name → first line that loads it
  mounts: Mount[];
  guard: { line: number; name: string } | null; // whole file behind auth: router.use(requireAuth) before any route, class-level @UseGuards(...)
  hasRoutes: boolean; // declares Router()/route handlers
  listens: number | null; // line of .listen( / createServer(
  dynamic: boolean; // require(someVariable): imports we cannot follow
}

const pkgOf = (spec: string): string | null => {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.includes(':')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : null) : parts[0]!;
};

/** Split a call's argument list at top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const calleeOf = (arg: string) => arg.match(/^[\w$.]+/)?.[0] ?? '';
export const isGuardName = (arg: string) => {
  const callee = calleeOf(arg);
  if (!GUARD.test(callee)) return false;
  if (NOT_GUARD.test(callee) || NOT_GUARD_ARG.test(arg)) return false;
  if (/session/i.test(callee) && !SESSION_GUARD.test(callee)) return false;
  return true;
};

/** True if `prefix` is the guard's prefix or lies below it (segment boundary: /api guards /api/x, not /api-public). */
const underPrefix = (prefix: string, guard: string) => {
  const g = guard.length > 1 ? guard.replace(/\/+$/, '') : guard;
  const p = prefix.length > 1 ? prefix.replace(/\/+$/, '') : prefix;
  return g === '/' || p === g || p.startsWith(`${g}/`);
};

/** Drop a trailing `// comment` that follows the call's closing `)` or `;`. */
function stripLineComment(t: string): string {
  let i = t.indexOf('//');
  while (i >= 0) {
    const before = t.slice(0, i).trimEnd();
    if (before.endsWith(')') || before.endsWith(';')) return before;
    i = t.indexOf('//', i + 2);
  }
  return t;
}

export interface Graph {
  files: Map<string, FileInfo>;
  dynamic: string[]; // files with imports we could not follow
}

/**
 * Parse every source file. `knownPackages` are the project's direct dependencies: a file that names one in a
 * string (e.g. `app.set('view engine', 'ejs')`) counts as loading it, because frameworks load those by name.
 * `workspaces` maps monorepo package names to their folder so `import '@acme/shared'` is followed.
 */
export function buildGraph(sources: SourceFile[], knownPackages: Set<string>, workspaces: Map<string, string> = new Map()): Graph {
  const byPath = new Map(sources.map((s) => [s.path.replace(/^\.\//, ''), s]));
  const resolveFrom = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith('.')) base = path.normalize(path.join(path.dirname(from), spec));
    else {
      const ws = [...workspaces].find(([name]) => spec === name || spec.startsWith(`${name}/`));
      if (!ws) return null;
      base = path.normalize(path.join(ws[1], spec.slice(ws[0].length)));
      for (const c of ['', '/src/index.ts', '/src/index.js']) if (byPath.has(base + c) && c) return base + c;
    }
    for (const ext of RESOLVE_EXT) if (byPath.has(base + ext)) return base + ext;
    // TypeScript ESM: `import './x.js'` points at x.ts
    const ts = base.replace(/\.(m|c)?js$/, '.ts');
    if (ts !== base && byPath.has(ts)) return ts;
    if (ts !== base && byPath.has(`${ts}x`)) return `${ts}x`;
    return null;
  };

  const files = new Map<string, FileInfo>();
  const idents = new Map<string, Map<string, string>>(); // file → local name → resolved file
  for (const [p, src] of byPath) {
    const info: FileInfo = { path: p, lines: [], edges: new Map(), packages: new Map(), mounts: [], guard: null, hasRoutes: false, listens: null, dynamic: false };
    files.set(p, info);
    const names = new Map<string, string>();
    idents.set(p, names);
    if (src.content.length > MAX_SOURCE_BYTES) {
      info.dynamic = true; // too big to analyse: the graph is incomplete
      continue;
    }
    const lines = src.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.length > MAX_LINE) {
        lines[i] = '';
        info.dynamic = true; // minified or hostile line: imports on it were not followed
      }
    }
    info.lines = lines;
    const addSpec = (spec: string, line: number) => {
      const target = resolveFrom(p, spec);
      if (target) {
        if (!info.edges.has(target)) info.edges.set(target, line);
        return target;
      }
      const pkg = pkgOf(spec);
      if (pkg && !info.packages.has(pkg)) info.packages.set(pkg, line);
      return null;
    };
    let classCount = 0;
    let classSeen = false;
    let guardCandidate: { line: number; name: string } | null = null;
    lines.forEach((text, i) => {
      const ln = i + 1;
      // Framework-loaded packages: a string literal that names a known package (one pass, set lookup).
      for (let q = 0; q < text.length; q++) {
        const c = text[q]!;
        if (c !== '"' && c !== "'" && c !== '`') continue;
        const end = text.indexOf(c, q + 1);
        if (end < 0) break;
        const lit = text.slice(q + 1, end);
        q = end;
        const pkg = lit.length > 0 && lit.length < 215 ? pkgOf(lit) : null;
        if (pkg && knownPackages.has(pkg) && !info.packages.has(pkg)) info.packages.set(pkg, ln);
      }
      if (/^[ \t]*(\/\/|\*|\/\*)/.test(text)) return;
      for (const m of text.matchAll(/\brequire\([ \t]*(['"`])([^'"`$]+)\1[ \t]*\)/g)) addSpec(m[2]!, ln);
      for (const m of text.matchAll(/\bimport\([ \t]*(['"`])([^'"`$]+)\1[ \t]*\)/g)) addSpec(m[2]!, ln);
      const t = text.trimEnd();
      const from = t.match(/(?:^|[\s}*])from[ \t]*(['"])([^'"\s]+)\1;?$/) ?? t.match(/^[ \t]*import[ \t]*(['"])([^'"]+)\1/);
      if (from) addSpec(from[2]!, ln);
      if (/\b(?:require|import)\([ \t]*[^'"`\s)]/.test(text) || /\b(?:require|import)\([ \t]*`[^`$]*\$\{/.test(text)) info.dynamic = true;
      if (info.listens === null && /\.listen[ \t]*\(|\bcreateServer[ \t]*\(|\bserve[ \t]*\([ \t]*\{|\bBun\.serve[ \t]*\(/.test(text)) info.listens = ln;
      if (!info.hasRoutes && ROUTES.test(text)) info.hasRoutes = true;

      // NestJS: only a class-level guard (decorator above the single `class`) that names an auth guard counts.
      if (/^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?class\b/.test(text)) {
        classCount++;
        classSeen = true;
      }
      const ug = !classSeen && !guardCandidate ? text.match(/@UseGuards[ \t]*\(([^\n]*)/) : null;
      if (ug) {
        const arg = ug[1]!.includes(')') ? ug[1]! : `${ug[1]} ${lines[i + 1] ?? ''} ${lines[i + 2] ?? ''}`;
        if (/Auth|Jwt|Session|Role/.test(arg) && !/Throttl/i.test(arg)) guardCandidate = { line: ln, name: text.trim().slice(0, 80) };
      }

      // Local names bound to relative imports, for `app.use('/x', name)`.
      const req = text.match(/\b(?:const|let|var)[ \t]+([\w$]+)[ \t]*=[ \t]*require\([ \t]*['"]([^'"]+)['"][ \t]*\)/);
      if (req) {
        const t2 = resolveFrom(p, req[2]!);
        if (t2) names.set(req[1]!, t2);
      }
      const destr = text.match(/\b(?:const|let|var)[ \t]*\{([^}]*)\}[ \t]*=[ \t]*require\([ \t]*['"]([^'"]+)['"][ \t]*\)/);
      let imp: [string, string] | null = null;
      const im = text.match(/^[ \t]*import\b([^'"]*)(['"])([^'"]+)\2/);
      if (im) {
        const clause = im[1]!.trim();
        if (clause.endsWith('from')) imp = [clause.slice(0, -4).trim(), im[3]!];
      }
      for (const [clause, spec] of [destr ? [`{${destr[1]}}`, destr[2]!] : null, imp].filter(Boolean) as [string, string][]) {
        const t2 = resolveFrom(p, spec);
        if (!t2) continue;
        const braces = clause.match(/\{([^}]*)\}/)?.[1] ?? '';
        for (const part of braces.split(',')) {
          const local = part.split(/\s+as\s+|:/).pop()?.trim();
          if (local) names.set(local, t2);
        }
        const rest = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '');
        for (const n of rest.split(',')) if (/^[\w$]+$/.test(n.trim())) names.set(n.trim(), t2);
      }
    });
    if (guardCandidate && classCount === 1) info.guard = guardCandidate;
  }

  // Second pass: `.use()` mounts, now that we know which files declare routes.
  const isRouterFile = (f: string) => files.get(f)?.hasRoutes ?? false;
  for (const info of files.values()) {
    const names = idents.get(info.path)!;
    let globalGuard = null as { line: number; name: string } | null;
    let firstRoute = null as number | null; // first route handler line: a file-level guard only covers what comes after it
    const prefixGuards: { prefix: string; guard: { line: number; name: string } }[] = [];
    info.lines.forEach((text, i) => {
      if (/^[ \t]*(\/\/|\*)/.test(text)) return;
      if (firstRoute === null && ROUTE_DECL.test(text)) firstRoute = i + 1;
      let t = stripLineComment(text.trimEnd());
      if (t.endsWith(';')) t = t.slice(0, -1).trimEnd();
      if (!t.endsWith(')')) return;
      const m = t.match(/\b[\w$]+\.(?:use|register)\(/);
      if (!m) return;
      let args = splitArgs(t.slice(m.index! + m[0].length, -1));
      let prefix = '';
      const lit = args[0]?.match(/^(['"`])([^'"`]*)\1$/);
      if (lit) {
        prefix = lit[2]!;
        args = args.slice(1);
      }
      const targetOf = (a: string): string | null => {
        const r = a.match(/^require\([ \t]*['"]([^'"]+)['"][ \t]*\)/);
        if (r) return resolveFrom(info.path, r[1]!);
        return /^[\w$]+$/.test(a) ? (names.get(a) ?? null) : null;
      };
      const routers = args.map((a) => [a, targetOf(a)] as const).filter(([, t2]) => t2 && isRouterFile(t2));
      const guards = args.filter((a) => !routers.some(([r]) => r === a) && isGuardName(a));
      const g = guards[0] ? { line: i + 1, name: calleeOf(guards[0]) } : null;
      // A mount, or `.use('/x', handler)` that is not just a guard, is a route declaration.
      if (firstRoute === null && (routers.length || (prefix && !g))) firstRoute = i + 1;
      if (routers.length) {
        const inherited = (globalGuard ?? prefixGuards.find((pg) => underPrefix(prefix, pg.prefix))?.guard) || null;
        for (const [, t2] of routers) info.mounts.push({ line: i + 1, prefix, target: t2!, guard: g ?? inherited });
      } else if (g) {
        if (prefix && prefix !== '/') prefixGuards.push({ prefix, guard: g });
        else globalGuard ??= g;
      }
    });
    // A route file that guards itself (`router.use(requireAuth)`) puts the handlers declared AFTER the guard behind
    // login. Express runs middleware in order, so one declared before it is open: no route may precede the guard.
    if (globalGuard && info.listens === null && !info.guard && (firstRoute === null || firstRoute > globalGuard.line)) info.guard = globalGuard;
  }

  return { files, dynamic: [...files.values()].filter((f) => f.dynamic).map((f) => f.path) };
}

export interface Reach {
  level: Exposure;
  via: Set<string>; // components whose entry file reaches this file
  guard?: ContextEvidence; // the auth middleware that capped this file, if any
}

/** Walk the import graph from each entry point, carrying its exposure; auth-guarded mounts cap it at "login". */
export function propagate(graph: Graph, entries: { file: string; exposure: Exposure; component: string }[]): Map<string, Reach> {
  const reach = new Map<string, Reach>();
  const queue: string[] = [];
  const quote = (f: FileInfo, line: number): ContextEvidence => ({ file: f.path, line, quote: (f.lines[line - 1] ?? '').trim().slice(0, 200) });
  const offer = (file: string, level: Exposure, via: Iterable<string>, guard?: ContextEvidence) => {
    const own = graph.files.get(file)!;
    if (own.guard && RANK[level] > RANK.login) {
      level = 'login';
      guard = quote(own, own.guard.line);
    }
    const cur = reach.get(file);
    if (!cur) {
      reach.set(file, { level, via: new Set(via), guard });
      queue.push(file);
      return;
    }
    let changed = false;
    if (RANK[level] > RANK[cur.level]) {
      cur.level = level;
      cur.guard = guard;
      changed = true;
    }
    for (const v of via) if (!cur.via.has(v)) (cur.via.add(v), (changed = true));
    if (changed) queue.push(file);
  };
  for (const e of entries) if (graph.files.has(e.file)) offer(e.file, e.exposure, [e.component]);

  while (queue.length) {
    const f = graph.files.get(queue.shift()!)!;
    const { level, guard, via } = reach.get(f.path)!;
    for (const target of f.edges.keys()) {
      const mounts = f.mounts.filter((m) => m.target === target);
      const guarded = mounts.length > 0 && mounts.every((m) => m.guard);
      if (guarded && RANK[level] > RANK.login) offer(target, 'login', via, quote(f, mounts[0]!.guard!.line));
      else offer(target, level, via, guard);
    }
  }
  return reach;
}

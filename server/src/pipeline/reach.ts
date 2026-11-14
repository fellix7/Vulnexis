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
// A file that declares routes (so mounting it exposes its handlers).
const ROUTES = /\b(express\.)?Router\s*\(|\.(get|post|put|patch|delete|all|route)\s*\(\s*['"`]/;

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
  guard: { line: number; name: string } | null; // whole file behind auth: router.use(requireAuth), @UseGuards(...)
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
export const isGuardName = (arg: string) => GUARD.test(calleeOf(arg));

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
    const lines = src.content.split(/\r?\n/);
    const info: FileInfo = { path: p, lines, edges: new Map(), packages: new Map(), mounts: [], guard: null, listens: null, dynamic: false };
    const names = new Map<string, string>();
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
    lines.forEach((text, i) => {
      const ln = i + 1;
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
      for (const m of text.matchAll(/\brequire\(\s*(['"`])([^'"`$]+)\1\s*\)/g)) addSpec(m[2]!, ln);
      for (const m of text.matchAll(/\bimport\(\s*(['"`])([^'"`$]+)\1\s*\)/g)) addSpec(m[2]!, ln);
      const from = text.match(/(?:^|[\s}*])from\s*(['"])([^'"\s]+)\1\s*;?\s*$/) ?? text.match(/^\s*import\s*(['"])([^'"]+)\1/);
      if (from) addSpec(from[2]!, ln);
      if (/\b(require|import)\(\s*([^'"`\s)]|`[^`]*\$\{)/.test(text)) info.dynamic = true;
      if (info.listens === null && /\.listen\s*\(|\bcreateServer\s*\(|\bserve\s*\(\s*\{|\bBun\.serve\s*\(/.test(text)) info.listens = ln;
      if (!info.guard && /@UseGuards\s*\(/.test(text)) info.guard = { line: ln, name: text.trim().slice(0, 80) };

      // Local names bound to relative imports, for `app.use('/x', name)`.
      const req = text.match(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
      if (req) {
        const t = resolveFrom(p, req[2]!);
        if (t) names.set(req[1]!, t);
      }
      const destr = text.match(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
      const imp = text.match(/\bimport\s+(.+?)\s+from\s*['"]([^'"]+)['"]/);
      for (const [clause, spec] of [destr ? [`{${destr[1]}}`, destr[2]!] : null, imp ? [imp[1]!, imp[2]!] : null].filter(Boolean) as [string, string][]) {
        const t = resolveFrom(p, spec);
        if (!t) continue;
        const braces = clause.match(/\{([^}]*)\}/)?.[1] ?? '';
        for (const part of braces.split(',')) {
          const local = part.split(/\s+as\s+|:/).pop()?.trim();
          if (local) names.set(local, t);
        }
        const rest = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '');
        for (const n of rest.split(',')) if (/^[\w$]+$/.test(n.trim())) names.set(n.trim(), t);
      }
    });
    // Framework-loaded packages: named in a string anywhere in the file.
    for (const pkg of knownPackages) {
      if (info.packages.has(pkg)) continue;
      const re = new RegExp(`(['"\`])${pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\1|/)`);
      const i = lines.findIndex((l) => re.test(l));
      if (i >= 0) info.packages.set(pkg, i + 1);
    }
    files.set(p, info);
    idents.set(p, names);
  }

  // Second pass: `.use()` mounts, now that we know which files declare routes.
  const isRouterFile = (f: string) => ROUTES.test(byPath.get(f)?.content ?? '');
  for (const info of files.values()) {
    const names = idents.get(info.path)!;
    let globalGuard: { line: number; name: string } | null = null;
    const prefixGuards: { prefix: string; guard: { line: number; name: string } }[] = [];
    info.lines.forEach((text, i) => {
      const m = text.match(/\b[\w$]+\.(?:use|register)\(\s*(.*?)\)\s*;?\s*(\/\/.*)?$/);
      if (!m || /^\s*(\/\/|\*)/.test(text)) return;
      let args = splitArgs(m[1]!);
      let prefix = '';
      const lit = args[0]?.match(/^(['"`])([^'"`]*)\1$/);
      if (lit) {
        prefix = lit[2]!;
        args = args.slice(1);
      }
      const targetOf = (a: string): string | null => {
        const r = a.match(/^require\(\s*['"]([^'"]+)['"]\s*\)/);
        if (r) return resolveFrom(info.path, r[1]!);
        return /^[\w$]+$/.test(a) ? (names.get(a) ?? null) : null;
      };
      const routers = args.map((a) => [a, targetOf(a)] as const).filter(([, t]) => t && isRouterFile(t));
      const guards = args.filter((a) => !routers.some(([r]) => r === a) && isGuardName(a));
      const g = guards[0] ? { line: i + 1, name: calleeOf(guards[0]) } : null;
      if (routers.length) {
        const inherited = (globalGuard ?? prefixGuards.find((pg) => prefix.startsWith(pg.prefix))?.guard) || null;
        for (const [, t] of routers) info.mounts.push({ line: i + 1, prefix, target: t!, guard: g ?? inherited });
      } else if (g) {
        if (prefix) prefixGuards.push({ prefix, guard: g });
        else globalGuard ??= g;
      }
    });
    // A route file that guards itself (`router.use(requireAuth)`) puts all its handlers behind login.
    if (globalGuard && info.listens === null && !info.guard) info.guard = globalGuard;
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

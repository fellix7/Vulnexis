import type { Package } from '../types.js';

const NM = 'node_modules/';
const REGEN_HINT =
  'Regenerate the lockfile with npm 7 or newer, e.g. `npm install --package-lock-only`, and upload the new package-lock.json.';

type Obj = Record<string, unknown>;

export const MAX_LOCK_PACKAGES = 20_000;
const MAX_KEY_CHARS = 1_000;
const MAX_NEST_DEPTH = 40;
const MAX_PATH_NAMES = 8; // first + last 7
const ROOTS_BUDGET = 2_000_000; // node and edge visits across all roots in packageRoots

/** Throws a user-facing Error when the lockfile is too big or too deeply nested to analyse safely. */
function checkLimits(packages: Obj): string[] {
  const keys = Object.keys(packages);
  if (keys.length > MAX_LOCK_PACKAGES) {
    throw new Error(
      `This lockfile lists more than ${MAX_LOCK_PACKAGES.toLocaleString('en-US')} packages, which is over the limit Vulnera can scan. Scan a smaller project or a single workspace's lockfile.`,
    );
  }
  for (const k of keys) {
    if (k.length > MAX_KEY_CHARS) {
      throw new Error(`Invalid package-lock.json: a package path is longer than ${MAX_KEY_CHARS} characters.`);
    }
    let depth = 0;
    for (let i = k.indexOf(NM); i !== -1; i = k.indexOf(NM, i + NM.length)) {
      if (++depth > MAX_NEST_DEPTH) {
        throw new Error(`Invalid package-lock.json: packages are nested more than ${MAX_NEST_DEPTH} levels deep.`);
      }
    }
  }
  return keys;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Dependency names declared by an entry in the given fields. Ignores fields of the wrong shape. */
function depNames(entry: Obj, fields: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const v = entry[f];
    if (isObj(v)) out.push(...Object.keys(v));
  }
  return out;
}

/** Package name from a lockfile key: the segment after the LAST `node_modules/`. null for keys that are not installed packages (workspace sources). */
function nameFromKey(key: string): string | null {
  const i = key.lastIndexOf(NM);
  if (i === -1) return null;
  if (i > 0 && key[i - 1] !== '/') return null;
  const name = key.slice(i + NM.length);
  return name.length > 0 ? name : null;
}

/** Location enclosing `loc` in Node's resolution walk (strip the last node_modules/<name>). */
function parentLocation(loc: string): string {
  const i = loc.lastIndexOf(NM);
  if (i <= 0) return '';
  return loc.slice(0, i - 1);
}

interface Acc {
  name: string;
  version: string;
  direct: boolean;
  dev: boolean;
  path: string[];
  depth: number;
}

const edgeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** Node's lookup: the installed location `dep` resolves to when required from `from`. */
function resolver(entries: Map<string, Obj>) {
  const memo = new Map<string, Map<string, string | null>>();
  return (from: string, dep: string): string | null => {
    let byDep = memo.get(from);
    if (!byDep) memo.set(from, (byDep = new Map()));
    const hit = byDep.get(dep);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    let loc = from;
    for (;;) {
      const cand = loc === '' ? NM + dep : `${loc}/${NM}${dep}`;
      const e = entries.get(cand);
      if (e && e.link !== true) {
        found = cand;
        break;
      }
      if (loc === '') break;
      loc = parentLocation(loc);
    }
    byDep.set(dep, found);
    return found;
  };
}

/**
 * For each installed `name@version`, every direct dependency whose dependency tree contains it
 * (a package can be pulled in by several). Used to ask "does the code that imports X run in production?".
 * Call after parseLockfile has validated the lockfile.
 */
export function packageRoots(lock: unknown): Map<string, Set<string>> {
  return packageRootsWithStatus(lock).roots;
}

/** Like packageRoots, but with a work budget; `complete` is false when the budget ran out or the lockfile is over the limits (the map is then partial). */
export function packageRootsWithStatus(lock: unknown): { roots: Map<string, Set<string>>; complete: boolean } {
  const out = new Map<string, Set<string>>();
  if (!isObj(lock) || !isObj(lock.packages)) return { roots: out, complete: true };
  let keys: string[];
  try {
    keys = checkLimits(lock.packages);
  } catch {
    return { roots: out, complete: false };
  }
  const entries = new Map<string, Obj>();
  for (const key of keys) {
    const val = lock.packages[key];
    if (isObj(val)) entries.set(key, val);
  }
  const resolve = resolver(entries);
  const idOf = (loc: string) => {
    const e = entries.get(loc)!;
    const name = typeof e.name === 'string' && e.name ? e.name : nameFromKey(loc);
    return `${name}@${String(e.version)}`;
  };
  // Direct dependencies of the root project and of each workspace member.
  const roots: [from: string, name: string][] = [];
  for (const [key, e] of entries) {
    if (key === '' || (e.link !== true && nameFromKey(key) === null)) {
      for (const n of depNames(e, ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])) roots.push([key, n]);
    }
  }
  let budget = ROOTS_BUDGET;
  for (const [from, root] of roots) {
    const start = resolve(from, root);
    if (!start) continue;
    const seen = new Set([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      if (--budget < 0) return { roots: out, complete: false };
      const loc = queue[i]!;
      const id = idOf(loc);
      (out.get(id) ?? out.set(id, new Set()).get(id)!).add(root);
      for (const dep of depNames(entries.get(loc)!, edgeFields)) {
        if (--budget < 0) return { roots: out, complete: false };
        const t = resolve(loc, dep);
        if (t && !seen.has(t)) {
          seen.add(t);
          queue.push(t);
        }
      }
    }
  }
  return { roots: out, complete: true };
}

/** Workspace members of a monorepo: package name → folder (e.g. "@acme/shared" → "packages/shared"). */
export function workspaceDirs(lock: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isObj(lock) || !isObj(lock.packages)) return out;
  for (const [key, e] of Object.entries(lock.packages)) {
    const name = nameFromKey(key);
    if (name && isObj(e) && e.link === true && typeof e.resolved === 'string') out.set(name, e.resolved);
  }
  return out;
}

/**
 * Parse an npm lockfile (v2/v3) into a flat, de-duplicated package inventory.
 * Throws an Error with a user-facing message on unsupported or malformed input.
 */
export function parseLockfile(lock: unknown): Package[] {
  if (!isObj(lock)) {
    throw new Error('Invalid package-lock.json: expected a JSON object at the top level.');
  }
  if (lock.lockfileVersion === 1) {
    throw new Error(`Unsupported lockfile: lockfileVersion 1 (npm 6 or older) has no "packages" map. ${REGEN_HINT}`);
  }
  const packages = lock.packages;
  if (packages === undefined || packages === null) {
    throw new Error(
      `Unsupported lockfile: no "packages" map found (lockfileVersion 1, or not an npm lockfile). ${REGEN_HINT}`,
    );
  }
  if (!isObj(packages)) {
    throw new Error('Invalid package-lock.json: "packages" must be an object.');
  }

  const entries = new Map<string, Obj>();
  for (const key of checkLimits(packages)) {
    const val = packages[key];
    if (isObj(val)) entries.set(key, val);
  }
  if (entries.size === 0) {
    throw new Error('Invalid package-lock.json: "packages" map is empty. Is this a complete npm lockfile?');
  }

  // Names declared by the root project (and by workspace members, whose deps are hoisted to the top level too).
  const declFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
  const rootNames = new Set<string>();
  const root = entries.get('');
  if (root) for (const n of depNames(root, declFields)) rootNames.add(n);
  for (const [key, e] of entries) {
    if (key !== '' && e.link !== true && nameFromKey(key) === null) {
      for (const n of depNames(e, declFields)) rootNames.add(n);
    }
  }

  const resolve = resolver(entries);

  // BFS from all direct deps over installed locations; first visit = shortest chain.
  // Each location stores only a parent pointer; the (truncated) path is built at the end.
  interface Hop {
    parent: string | null;
    name: string;
    root: string;
    depth: number;
  }
  const hops = new Map<string, Hop>();
  const queue: string[] = [];
  for (const n of rootNames) {
    const loc = NM + n;
    const e = entries.get(loc);
    if (e && e.link !== true && !hops.has(loc)) {
      hops.set(loc, { parent: null, name: n, root: n, depth: 1 });
      queue.push(loc);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const loc = queue[qi]!;
    const h = hops.get(loc)!;
    for (const dep of depNames(entries.get(loc)!, edgeFields)) {
      const target = resolve(loc, dep);
      if (target && !hops.has(target)) {
        hops.set(target, { parent: loc, name: nameFromKey(target) ?? dep, root: h.root, depth: h.depth + 1 });
        queue.push(target);
      }
    }
  }
  /** Chain from the direct dependency to `key`; long chains keep the first name and the last 7. */
  const pathOf = (key: string): string[] | null => {
    const h = hops.get(key);
    if (!h) return null;
    const long = h.depth > MAX_PATH_NAMES;
    const tail: string[] = [];
    let cur: Hop | undefined = h;
    for (let i = 0, n = long ? MAX_PATH_NAMES - 1 : h.depth; i < n && cur; i++) {
      tail.push(cur.name);
      cur = cur.parent === null ? undefined : hops.get(cur.parent);
    }
    tail.reverse();
    return long ? [h.root, ...tail] : tail;
  };

  const acc = new Map<string, Acc>();
  for (const [key, e] of entries) {
    if (key === '' || e.link === true) continue;
    const name = nameFromKey(key);
    if (name === null) continue;
    if (typeof e.version !== 'string' || e.version === '') continue;

    const isDirect = key === NM + name && rootNames.has(name);
    const dev = e.dev === true;
    const path = pathOf(key) ?? [name];
    const depth = hops.get(key)?.depth ?? 1;
    // Aliased installs ("lodash-old": "npm:lodash@4.17.15") are keyed by the alias but record the real
    // registry name in `name`; vulnerability lookups and upgrade commands need the real one.
    const registryName = typeof e.name === 'string' && e.name !== '' ? e.name : name;
    const id = `${registryName}@${e.version}`;
    const cur = acc.get(id);
    if (!cur) {
      acc.set(id, { name: registryName, version: e.version, direct: isDirect, dev, path, depth });
    } else {
      cur.direct = cur.direct || isDirect;
      cur.dev = cur.dev && dev;
      if (depth < cur.depth) {
        cur.path = path;
        cur.depth = depth;
      }
    }
  }

  return [...acc.values()]
    .map(({ depth: _d, ...p }) => p)
    .sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
  );
}

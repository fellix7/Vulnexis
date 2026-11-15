import semver from 'semver';
import { cached, OfflineMissError } from '../cache.js';
import type { Advisory, Package, UpgradePlan } from '../types.js';
import { mapLimit, queryVersions } from './osv.js';
import { fetchRetry } from '../http.js';
import { stats } from '../scanStats.js';
import { isMalicious } from './score.js';

const MAX_VERIFY_TRIES = 5;

// Cache only the list of version strings; the full registry document can be megabytes.
async function registryVersions(name: string): Promise<string[]> {
  return cached<string[]>('npm-registry', name, () =>
    fetchRetry(
      `https://registry.npmjs.org/${name.replace('/', '%2f')}`,
      { headers: { Accept: 'application/vnd.npm.install-v1+json' } },
      async (res) => Object.keys(((await res.json()) as { versions?: Record<string, unknown> }).versions ?? {}),
    ),
  );
}

function jumpOf(from: string, to: string): UpgradePlan['jump'] {
  const d = semver.diff(from, to);
  if (!d) return null;
  if (d === 'major' || d === 'premajor') return 'major';
  if (d === 'minor' || d === 'preminor') return 'minor';
  return 'patch'; // patch, prepatch, prerelease
}

function commandFor(pkg: Package, to: string): string {
  if (pkg.direct) return `npm install ${pkg.dev ? '-D ' : ''}${pkg.name}@${to}`;
  // `npm pkg set` splits keys on dots (socket.io becomes socket > io), so dotted names get a JSON snippet.
  if (pkg.name.includes('.')) return `Add to package.json: "overrides": { "${pkg.name}": "${to}" }`;
  return `npm pkg set overrides.${pkg.name}=${to}`;
}

/** Smallest version that clears every advisory, or null when some advisory has no fix above `current`. */
function candidateFor(current: string, advisories: Advisory[]): string | null {
  let candidate: string | null = null;
  for (const adv of advisories) {
    const next = adv.fixedVersions.filter((v) => semver.gt(v, current)).sort(semver.compare)[0];
    if (!next) return null;
    if (!candidate || semver.gt(next, candidate)) candidate = next;
  }
  return candidate;
}

const REGISTRY_CONCURRENCY = 8;

/**
 * Smallest verified-clean version per vulnerable package, or null. Lookups are batched:
 * one OSV call for every candidate, then one for the fallbacks of the candidates that were still vulnerable.
 */
async function resolveFixes(entries: { pkg: Package; advisories: Advisory[] }[]): Promise<(string | null)[]> {
  const candidates = entries.map(({ pkg, advisories }) => candidateFor(pkg.version, advisories));
  const probes = entries.flatMap((e, i) => (candidates[i] ? [{ name: e.pkg.name, version: candidates[i]! }] : []));
  let probeResults: string[][];
  try {
    probeResults = await queryVersions(probes);
  } catch (e) {
    // OSV unreachable and nothing saved: no upgrade can be verified, but the scan itself still stands.
    if (e instanceof OfflineMissError) throw e;
    stats().unverifiedByNetwork += probes.length;
    return entries.map(() => null);
  }
  const vulnerable = new Map(probes.map((p, k) => [`${p.name}@${p.version}`, probeResults[k]!.length > 0]));

  // Candidates that are themselves vulnerable: look at the next stable releases above them.
  const retryIdx = entries.map((_e, i) => i).filter((i) => candidates[i] && vulnerable.get(`${entries[i]!.pkg.name}@${candidates[i]}`));
  let higherLists: string[][];
  let retryResults: string[][];
  try {
    higherLists = await mapLimit(retryIdx, REGISTRY_CONCURRENCY, async (i) => {
      const name = entries[i]!.pkg.name;
      const candidate = candidates[i]!;
      return (await registryVersions(name))
        .filter((v) => semver.valid(v) && !semver.prerelease(v) && semver.gt(v, candidate))
        .sort(semver.compare)
        .slice(0, MAX_VERIFY_TRIES);
    });
    const retryProbes = retryIdx.flatMap((i, k) => higherLists[k]!.map((version) => ({ name: entries[i]!.pkg.name, version })));
    retryResults = await queryVersions(retryProbes);
  } catch (e) {
    if (e instanceof OfflineMissError) throw e;
    stats().unverifiedByNetwork += retryIdx.length;
    higherLists = retryIdx.map(() => []);
    retryResults = [];
  }

  const fixes: (string | null)[] = entries.map((e, i) => {
    const c = candidates[i];
    return c && !vulnerable.get(`${e.pkg.name}@${c}`) ? c : null;
  });
  let offset = 0;
  retryIdx.forEach((i, k) => {
    const list = higherLists[k]!;
    const clean = retryResults.slice(offset, offset + list.length).findIndex((r) => r.length === 0);
    fixes[i] = clean === -1 ? null : list[clean]!;
    offset += list.length;
  });
  return fixes;
}

export async function planUpgrades(matches: { pkg: Package; advisory: Advisory }[]): Promise<UpgradePlan[]> {
  const groups = new Map<string, { pkg: Package; advisories: Advisory[] }>();
  for (const { pkg, advisory } of matches) {
    const key = `${pkg.name}@${pkg.version}`;
    const g = groups.get(key) ?? { pkg, advisories: [] };
    g.advisories.push(advisory);
    groups.set(key, g);
  }

  const entries = [...groups.values()];
  // A malicious package has no safe version: the only fix is to remove it, so it is never probed for upgrades.
  const malicious = entries.map((e) => e.advisories.some(isMalicious));
  const upgradable = entries.filter((_e, i) => !malicious[i]);
  const resolved = await resolveFixes(upgradable);
  let next = 0;
  const fixes = entries.map((_e, i) => (malicious[i] ? null : resolved[next++]!));
  const plans = entries.map(({ pkg }, i) => {
    const to = fixes[i]!;
    const plan: UpgradePlan = {
      name: pkg.name,
      from: pkg.version,
      to,
      jump: to ? jumpOf(pkg.version, to) : null,
      command: malicious[i] ? `npm uninstall ${pkg.name}` : to ? commandFor(pkg, to) : null,
    };
    if (!pkg.direct && pkg.path[0]) plan.viaParent = pkg.path[0];
    return { plan, direct: pkg.direct };
  });

  return plans
    .sort(
      (a, b) =>
        Number(b.direct) - Number(a.direct) ||
        a.plan.name.localeCompare(b.plan.name) ||
        semver.compare(a.plan.from, b.plan.from),
    )
    .map((p) => p.plan);
}

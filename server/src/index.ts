import './net.js'; // first: route outbound requests through HTTPS_PROXY when one is set
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { Agent, plural, SOURCES } from './agent.js';
import { sourceMessage } from './net.js';
import { printDoctor, runDoctor } from './doctor.js';
import { OfflineMissError, savedFallbacks } from './cache.js';
import { analyzeFindings } from './pipeline/ai.js';
import { enrich } from './pipeline/enrich.js';
import { matchPackages } from './pipeline/match.js';
import { parseLockfile } from './pipeline/parse.js';
import { planUpgrades, unverifiedByNetwork } from './pipeline/plan.js';
import { fetchRepo, RepoError } from './pipeline/github.js';
import { buildContext, isContextPath } from './pipeline/context.js';
import { DEFAULT_EPSS_THRESHOLD, EXPOSURE_LABEL, scoreFindings, TIER_ORDER } from './pipeline/score.js';
import type { AgentStep, ExposureVerdict, Finding, Package, RepoRef, ScanRequest, ScanResult, SourceFile, Tier } from './types.js';

const TIER_NAME: Record<Tier, string> = { FIX_NOW: 'fix now', FIX_SPRINT: 'this sprint', PLAN: 'plan', MONITOR: 'monitor' };

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const SAMPLE_DIR = path.resolve(import.meta.dirname, '../../samples/demo-app');
const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/;

// Lockfiles are JSON; real-world ones run to a few MB.
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    offline: process.env.OFFLINE === '1',
    gemini: Boolean(process.env.GEMINI_API_KEY),
  });
});

// User-facing failure: message is safe to show in the UI.
class ScanError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

async function loadSample(): Promise<{ lockfile: unknown; sources: SourceFile[]; contextFiles: SourceFile[] }> {
  let lockfile: unknown;
  try {
    lockfile = JSON.parse(await readFile(path.join(SAMPLE_DIR, 'package-lock.json'), 'utf8'));
  } catch {
    throw new ScanError('Sample project is not available on this server.', 404);
  }
  const files = await readdir(SAMPLE_DIR, { recursive: true });
  const sources: SourceFile[] = [];
  const contextFiles: SourceFile[] = [];
  for (const rel of files) {
    const p = rel.split(path.sep).join('/');
    if (p.split('/').includes('node_modules')) continue;
    const list = SOURCE_EXT.test(p) ? sources : isContextPath(p) && p !== 'EXPECTED.md' ? contextFiles : null;
    list?.push({ path: p, content: await readFile(path.join(SAMPLE_DIR, rel), 'utf8') });
  }
  return { lockfile, sources, contextFiles };
}

async function scan(req: ScanRequest, onStep?: (step: AgentStep) => void, signal?: AbortSignal): Promise<ScanResult> {
  const notes: string[] = [];
  const agent = new Agent(onStep, signal);
  const fallbacksAtStart = savedFallbacks;
  const unverifiedAtStart = unverifiedByNetwork;
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  const offline = process.env.OFFLINE === '1';

  // 1. Get the project: bundled sample, a public GitHub repository, or an uploaded lockfile.
  let lockfile: unknown;
  let sources: SourceFile[];
  let contextFiles: SourceFile[] = [];
  let base = '';
  let truncated = false;
  let repo: RepoRef | undefined;
  if (req.sample) {
    ({ lockfile, sources, contextFiles } = await agent.run(
      'github',
      'Loading the bundled sample project',
      { input: 'samples/demo-app (QuickNotes, a deliberately outdated Express app)' },
      () => loadSample(),
      (v) => ({ output: `package-lock.json + ${plural(v.sources.length, 'source file')} + ${plural(v.contextFiles.length, 'architecture file')}` }),
    ));
  } else if (req.repoUrl) {
    const fetched = await agent.run(
      'github',
      'Reading the public GitHub repository',
      { input: req.repoUrl, sources: [SOURCES.github] },
      async () => {
        try {
          return await fetchRepo(req.repoUrl!);
        } catch (e) {
          if (e instanceof RepoError) throw new ScanError(e.message);
          throw new ScanError(sourceMessage('GitHub', e), 502);
        }
      },
      (v) => ({
        title: `Read ${v.repo.owner}/${v.repo.name} @ ${v.repo.ref}${v.repo.stars !== undefined ? ` (${v.repo.stars.toLocaleString('en-IN')} stars, ${v.repo.contributors !== undefined ? `${v.repo.contributors >= 500 ? '500+' : v.repo.contributors.toLocaleString('en-IN')} contributors` : 'contributors unknown'})` : ''}`,
        output: `${v.repo.lockfilePath} + ${plural(v.sources.length, 'source file')} + ${plural(v.contextFiles.length, 'architecture file')} (text only, nothing executed)`,
        decision: v.fallback
          ? `The full download failed (${v.fallback}), so I read only the root package-lock.json. The code check will be skipped.`
          : v.skipped > 0
            ? `Skipped ${plural(v.skipped, 'large or deep file')} to stay inside the 3 MB reading budget.`
            : undefined,
        sources: [{ label: `github.com/${v.repo.owner}/${v.repo.name}`, url: v.repo.url }],
      }),
    );
    ({ lockfile, sources, repo, contextFiles, base } = fetched);
    truncated = fetched.skipped > 0;
    if (fetched.fallback) notes.push(`Only the lockfile was read: the repository download failed (${fetched.fallback}). Upload the source folder to enable the code check.`);
  } else {
    lockfile = req.lockfile;
    sources = req.sources ?? [];
    contextFiles = Array.isArray(req.contextFiles) ? req.contextFiles.filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string').slice(0, 80) : [];
    truncated = req.sourcesTruncated === true;
  }
  if (!lockfile || typeof lockfile !== 'object') {
    throw new ScanError('Expected { lockfile }, { repoUrl } or { sample: true }.');
  }

  // 2. Plan: decide which tools this run needs, from what the user gave us and what the server can do.
  // Offline mode can still replay saved Gemini answers when they were committed to data/snapshots.
  const savedAi = offline && existsSync(path.resolve(import.meta.dirname, '../../data/snapshots/gemini-package'));
  const willInvestigate = sources.length > 0 && (hasKey || savedAi);
  agent.note('plan', 'Planning the investigation', {
    input: `lockfile ✓ · source files: ${sources.length} · architecture files: ${contextFiles.length} · Gemini key: ${hasKey ? 'yes' : 'no'} · data: ${offline ? 'saved snapshots' : 'live'}`,
    output: [
      'parse lockfile',
      'match OSV.dev',
      'enrich with EPSS + CISA KEV',
      contextFiles.length || sources.length ? 'map architecture & entry points' : null,
      'rank by fixed rules',
      willInvestigate ? 'read code with Gemini' : null,
      'verify safe versions',
    ]
      .filter(Boolean)
      .join(' → '),
    decision: willInvestigate
      ? 'Source code is available, so I will check whether your code actually calls each vulnerable function.'
      : sources.length === 0
        ? 'No source code was given, so I will skip the code check and mark code usage as "Not assessed" instead of guessing.'
        : 'No Gemini key on this server, so I will skip the code check and say so rather than guess.',
  });

  let packages: Package[];
  try {
    packages = await agent.run(
      'parse',
      'Reading the lockfile',
      { input: 'package-lock.json (lockfileVersion 2/3)' },
      async () => parseLockfile(lockfile),
      (v) => {
        const direct = v.filter((p) => p.direct).length;
        const dev = v.filter((p) => p.dev).length;
        return { title: `Read ${plural(v.length, 'installed package')}`, output: `${direct} direct · ${v.length - direct} transitive · ${dev} dev-only` };
      },
    );
  } catch (e) {
    throw new ScanError(e instanceof Error ? e.message : 'Could not read the lockfile.');
  }

  const matches = await agent.run(
    'osv',
    `Matching ${plural(packages.length, 'package')} against OSV.dev`,
    { input: 'exact name + version lookups (batched)', sources: [SOURCES.osv] },
    () => matchPackages(packages).catch((e) => {
      if (e instanceof OfflineMissError) throw e;
      throw new ScanError(sourceMessage('OSV.dev (the vulnerability database)', e), 502);
    }),
    (v) => {
      const pk = new Set(v.map((m) => `${m.pkg.name}@${m.pkg.version}`)).size;
      return {
        output: `${plural(v.length, 'known vulnerability', 'known vulnerabilities')} in ${plural(pk, 'package')}`,
        decision: v.length === 0 ? 'Nothing matched, so there is nothing to rank. Stopping early.' : 'Facts come from this lookup only. AI never adds or removes a finding.',
      };
    },
  );
  const advisories = [...new Map(matches.map((m) => [m.advisory.id, m.advisory])).values()];

  const enriched = await agent.run(
    'enrich',
    `Checking ${plural(advisories.length, 'advisory', 'advisories')} for real-world exploitation`,
    { input: 'CVE ids → EPSS score, CISA KEV membership', sources: [SOURCES.epss, SOURCES.kev] },
    () => enrich(advisories),
    (v) => {
      const vals = [...v.map.values()];
      const kev = vals.filter((e) => e.kev === true).length;
      const hot = vals.filter((e) => e.epss !== null && e.epss >= DEFAULT_EPSS_THRESHOLD).length;
      return {
        output: `${plural(kev, 'advisory', 'advisories')} on CISA KEV · ${hot} with EPSS ≥ 10%`,
        decision: kev > 0 ? `${plural(kev, 'vulnerability is', 'vulnerabilities are')} already exploited in real attacks; these go straight to "Fix now".` : undefined,
      };
    },
  );
  notes.push(...enriched.warnings);

  // Architecture context: which processes run, where they are exposed, and which code each one loads.
  let exposureOf: ((pkg: Package) => ExposureVerdict | undefined) | undefined;
  let context: ScanResult['context'];
  if (matches.length && (contextFiles.length || sources.length)) {
    const built = await agent.run(
      'context',
      'Mapping the architecture: entry points, exposure and login walls',
      {
        input: contextFiles.length
          ? `${plural(contextFiles.length, 'architecture file')} (${[...new Set(contextFiles.map((f) => f.path.split('/').pop()))].slice(0, 5).join(', ')}${contextFiles.length > 5 ? ', …' : ''}) + import graph of ${plural(sources.length, 'source file')}`
          : `no deployment files; import graph of ${plural(sources.length, 'source file')} and the servers they start`,
        sources: [SOURCES.ssvc, SOURCES.vex],
      },
      async () => buildContext({ lockfile, sources, contextFiles, base, truncated }),
      (v) => {
        if (!v) return { output: 'Nothing to map', decision: 'Ranking uses the published rules only.' };
        const c = v.context;
        const eps = c.entryPoints.map((e) => `${e.component} (${EXPOSURE_LABEL[e.exposure].toLowerCase()})`).slice(0, 4).join(' · ');
        return {
          title: `Mapped ${plural(c.entryPoints.length, 'entry point')}${c.protectedMounts.length ? ` and ${plural(c.protectedMounts.length, 'route')} behind login` : ''}`,
          output: `${eps || 'no entry points found'}${c.conflicts.length ? ` · ${plural(c.conflicts.length, 'conflict')} between docs and code` : ''}`,
          decision: c.entryPoints.length
            ? 'Packages loaded only behind login, on a private network, offline, or by nothing at all move down one step (never below Plan, never if exploited in the wild). Unknown exposure counts as internet-facing.'
            : 'No entry point found, so exposure is unknown and no priority changes.',
        };
      },
    );
    if (built) {
      exposureOf = built.exposureOf;
      context = built.context;
      notes.push(...built.context.conflicts.map((c) => `Architecture: ${c}`));
    }
  }

  // First pass without AI gives the order Gemini works through (most urgent first).
  const ranked = scoreFindings(matches, enriched.map, undefined, { exposureOf });
  const tiers = (fs: Finding[]) => TIER_ORDER.map((t) => `${fs.filter((f) => f.tier === t).length} ${TIER_NAME[t]}`).join(' · ');
  const directCount = ranked.filter((f) => f.pkg.direct).length;
  const lowered = ranked.filter((f) => f.exposure?.lowered).length;
  agent.note('rank', 'Ranking findings with fixed, published rules', {
    input: `KEV · EPSS ≥ 10% · severity · production vs dev · direct vs transitive${exposureOf ? ' · architecture exposure' : ''}`,
    output: `${tiers(ranked)}${lowered ? ` · ${plural(lowered, 'finding')} lowered by architecture` : ''}`,
    decision: willInvestigate
      ? `Next: read the code for the top ${Math.min(30, directCount)} direct-dependency findings, most urgent first.`
      : 'Ranking is final for this run (no code check).',
  });

  let ai: Awaited<ReturnType<typeof analyzeFindings>> = { verdicts: new Map(), status: 'disabled', warnings: [] };
  if (willInvestigate && ranked.length) {
    ai = await agent.run(
      'gemini',
      'Reading your code for calls to the vulnerable functions',
      {
        input: `${plural(sources.length, 'source file')} scanned locally; only short snippets around imports of vulnerable packages go to Gemini, secrets masked`,
        sources: [SOURCES.gemini],
      },
      () => analyzeFindings(ranked, sources),
      (v) => {
        const vs = [...v.verdicts.values()];
        const uses = vs.filter((x) => x.verdict === 'USES_VULNERABLE_API').length;
        const none = vs.filter((x) => x.verdict === 'NO_VULNERABLE_USAGE_FOUND').length;
        const unsure = vs.filter((x) => x.verdict === 'UNCERTAIN').length;
        const cites = vs.reduce((n, x) => n + x.citations.length, 0);
        return {
          output: `${uses} used · ${none} not used · ${unsure} uncertain · ${plural(cites, 'citation')} re-checked against the real files`,
          decision:
            v.status === 'error'
              ? 'The AI step failed; findings keep their rule-based tier and say "uncertain".'
              : uses > 0
                ? `Your code reaches ${plural(uses, 'vulnerable function')}. AI may only raise a priority, never lower it.`
                : 'No confirmed calls. "Not found" is shown as needing human review, not as safe.',
        };
      },
    );
    notes.push(...ai.warnings);
  } else {
    agent.note('gemini', 'Code check skipped', { output: sources.length ? 'No Gemini key configured' : 'No source code provided' }, 'skipped');
  }

  // AI can only raise a tier, so rescoring with verdicts is safe.
  const findings = ai.verdicts.size ? scoreFindings(matches, enriched.map, ai.verdicts, { exposureOf }) : ranked;
  if (ai.verdicts.size) {
    const raised = findings.filter((f) => f.tier === 'FIX_NOW').length - ranked.filter((f) => f.tier === 'FIX_NOW').length;
    if (raised > 0) agent.note('rank', `Re-ranked: ${plural(raised, 'finding')} raised to Fix now by code evidence`, { output: tiers(findings) });
  }

  const plans = await agent.run(
    'verify',
    'Finding the smallest safe upgrade for each package',
    { input: 'fixed versions from OSV → re-query OSV for each candidate → next releases from npm if still vulnerable', sources: [SOURCES.osv, SOURCES.npm] },
    () => planUpgrades(matches).catch((e) => {
      if (e instanceof OfflineMissError) throw e;
      throw new ScanError(sourceMessage(/registry\.npmjs/.test(String(e)) ? 'the npm registry' : 'OSV.dev (the vulnerability database)', e), 502);
    }),
    (v) => {
      const ok = v.filter((p) => p.to).length;
      const major = v.filter((p) => p.jump === 'major').length;
      return {
        output: `${ok} of ${plural(v.length, 'package')} have a verified clean version${major ? ` · ${major} need a major upgrade` : ''}`,
        decision: ok < v.length ? `${v.length - ok} have no verified fix yet; I will say so instead of suggesting an unverified version.` : 'Every upgrade target was re-checked and is clean.',
      };
    },
  );

  const fixNow = findings.filter((f) => f.tier === 'FIX_NOW').length;
  agent.note('report', 'Preparing the report', {
    output: `${plural(findings.length, 'finding')} · ${fixNow} to fix now · Hindi + English summary · CERT-In / DPDP brief`,
    decision: fixNow > 0 ? `Start with the ${plural(fixNow, 'Fix now item')}.` : 'Nothing needs an emergency fix. Work through the sprint list.',
  });

  const unverified = unverifiedByNetwork - unverifiedAtStart;
  if (unverified > 0) {
    notes.push(`${plural(unverified, 'upgrade')} could not be verified because OSV.dev or the npm registry was unreachable; they show "no verified fix" instead of a guess. Scan again on a network that allows them.`);
  }
  const fromSaved = savedFallbacks - fallbacksAtStart;
  if (fromSaved > 0) {
    notes.push(`The network blocked some live lookups, so ${plural(fromSaved, 'answer was', 'answers were')} taken from saved data. Results may be a little older than live data.`);
  }

  const result: ScanResult = {
    scannedAt: new Date().toISOString(),
    packageCount: packages.length,
    findings,
    plans,
    aiStatus: ai.status,
    notes,
    agent: agent.steps,
  };
  if (repo) result.repo = repo;
  if (context) result.context = context;
  return result;
}

function failure(e: unknown): { status: number; error: string } {
  if (e instanceof ScanError) return { status: e.status, error: e.message };
  if (e instanceof OfflineMissError) {
    return { status: 503, error: 'Offline mode: this project has no saved snapshot. Turn OFFLINE off or scan the sample.' };
  }
  console.error(e);
  return { status: 502, error: `The scan failed: ${e instanceof Error ? e.message : String(e)}` };
}

// Connection check: which services this server can reach, and what to do about the ones it cannot.
app.get('/api/doctor', async (_req, res) => {
  res.json(await runDoctor());
});

// Each scan can hold a repository tarball (up to 300 MB unpacked) in memory, so only a few run at once.
// shortcut: per-process counter; behind several instances, add rate limiting at the proxy instead.
const MAX_SCANS = Math.max(1, Number(process.env.MAX_CONCURRENT_SCANS) || 4);
let running = 0;
const BUSY = { status: 429, error: 'Vulnexis is busy with other scans right now. Try again in a minute.' };

// Streams the agent's steps as they happen (one JSON object per line), then the result.
app.post('/api/scan/stream', async (req, res) => {
  if (running >= MAX_SCANS) return void res.status(BUSY.status).json({ error: BUSY.error });
  running++;
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (obj: unknown) => {
    if (!abort.signal.aborted) res.write(`${JSON.stringify(obj)}\n`);
  };
  try {
    const result = await scan((req.body ?? {}) as ScanRequest, (step) => send({ type: 'step', step }), abort.signal);
    send({ type: 'result', result });
  } catch (e) {
    if (!abort.signal.aborted) send({ type: 'error', ...failure(e) });
  } finally {
    running--;
  }
  res.end();
});

app.post('/api/scan', async (req, res) => {
  if (running >= MAX_SCANS) return void res.status(BUSY.status).json({ error: BUSY.error });
  running++;
  try {
    res.json(await scan((req.body ?? {}) as ScanRequest));
  } catch (e) {
    const f = failure(e);
    res.status(f.status).json({ error: f.error });
  } finally {
    running--;
  }
});

// Production: serve the built client from the same origin (one process to deploy).
const CLIENT_DIST = path.resolve(import.meta.dirname, '../../client/dist');
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  // App routes only (no file extension): a missing /assets/x.js must 404, not return the HTML page.
  app.get(/^\/(?!api\/)[^.]*$/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`Vulnexis API listening on http://localhost:${PORT}`);
  runDoctor().then(printDoctor).catch(() => {});
});

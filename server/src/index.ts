import './env.js'; // first: NODE_ENV defaults (production for dist/, development for tsx)
import './net.js'; // second: route outbound requests through HTTPS_PROXY when one is set
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { Agent, heartbeat, plural, SOURCES } from './agent.js';
import { ClientLimitError, QueueFullError, ScanQueue } from './queue.js';
import { clientKey, createLimiter } from './ratelimit.js';
import { sourceMessage } from './net.js';
import { printDoctor, runDoctor, runDoctorCached } from './doctor.js';
import { OfflineMissError } from './cache.js';
import { runWithStats, savedDataNote, stats } from './scanStats.js';
import { doctorAccess, jsonErrorHandler, securityHeaders } from './security.js';
import { validateScanRequest, ValidationError } from './validate.js';
import { exhausted as aiBudgetExhausted } from './aiBudget.js';
import { keysRouter } from './apiKeys.js';
import { accountsEnabled } from './auth/config.js';
import { sameOrigin } from './auth/csrf.js';
import { authRouter } from './auth/routes.js';
import { callerOf, identify, requireKeyCaller } from './caller.js';
import { closeDb, dbEnabled } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { admit, refund } from './quota.js';
import { save as saveScan, scansRoutes, TOO_BIG_NOTE } from './scansStore.js';
import { startSweep } from './sweep.js';
import { analyzeFindings } from './pipeline/ai.js';
import { enrich, loadKev } from './pipeline/enrich.js';
import { matchPackages } from './pipeline/match.js';
import { planUpgrades } from './pipeline/plan.js';
import { fetchRepo, RepoError } from './pipeline/github.js';
import { isContextPath } from './pipeline/context.js';
import { buildContextAsync, parseLockfileAsync, shutdownWorkers } from './workers/pool.js';
import { DEFAULT_EPSS_THRESHOLD, EXPOSURE_LABEL, scoreFindings, TIER_ORDER } from './pipeline/score.js';
import type { AgentStep, ExposureVerdict, Finding, Package, RepoRef, ScanRequest, ScanResult, SourceFile, Tier } from './types.js';

declare module 'express-serve-static-core' {
  interface Request {
    queueTicket?: import('./queue.js').Ticket;
  }
}

const TIER_NAME: Record<Tier, string> = { FIX_NOW: 'fix now', FIX_SPRINT: 'this sprint', PLAN: 'plan', MONITOR: 'monitor' };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0); // number of reverse proxies in front (0 = none)
app.use(securityHeaders);
const PORT = Number(process.env.PORT ?? 8787);
const SAMPLE_DIR = path.resolve(import.meta.dirname, '../../samples/demo-app');
const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/;

// Lockfiles are JSON; real-world ones run to a few MB. Only the scan routes read a body, and the rate limit runs before it is parsed.
const scanBody = express.json({ limit: '10mb' });
const envNum = (name: string, def: number) => Number(process.env[name]) || def;
const scanLimiter = createLimiter({
  limits: [
    { windowMs: 60_000, max: envNum('SCAN_RATE_PER_MIN', 6) },
    { windowMs: 86_400_000, max: envNum('SCAN_RATE_PER_DAY', 100) },
  ],
});
const doctorLimiter = createLimiter({ limits: [{ windowMs: 60_000, max: 10 }], message: (m) => `Too many requests. Try again in ${m} ${m === 1 ? 'minute' : 'minutes'}.` });

// Anonymous callers with accounts on can only send {sample:true} or {repoUrl}: 4 KB is plenty.
const anonymousBody = express.json({ limit: '4kb' });
const bodyByCaller: express.RequestHandler = (req, res, next) =>
  (accountsEnabled() && callerOf(res).kind === 'anonymous' ? anonymousBody : scanBody)(req, res, next);
/** Anonymous uploads of any size are refused (the quota taken by `admit` is given back). */
const anonymousGuard: express.RequestHandler = async (req, res, next) => {
  const b = req.body as Record<string, unknown> | undefined;
  if (accountsEnabled() && callerOf(res).kind === 'anonymous' && b && (b.lockfile !== undefined || b.sources !== undefined || b.contextFiles !== undefined)) {
    await refund(res);
    return void res.status(401).json({ error: 'Sign in to upload a lockfile.', code: 'signin_required' });
  }
  next();
};

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    accounts: accountsEnabled(),
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

// Each scan runs inside its own stats scope, so concurrent scans never share counters or warnings.
const scan = (req: ScanRequest, onStep?: (step: AgentStep) => void, signal?: AbortSignal, aiEnabled = true): Promise<ScanResult> => runWithStats(() => runScan(req, onStep, signal, aiEnabled), signal);

async function runScan(req: ScanRequest, onStep?: (step: AgentStep) => void, signal?: AbortSignal, aiEnabled = true): Promise<ScanResult> {
  const notes: string[] = [];
  const agent = new Agent(onStep, signal);
  const st = stats();
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
  const canInvestigate = sources.length > 0 && (hasKey || savedAi);
  // The plan may exclude the AI step, and a monthly Gemini budget can run out: either way the rules alone rank the findings.
  const budgetUsed = canInvestigate && aiEnabled ? await aiBudgetExhausted() : false;
  const willInvestigate = canInvestigate && aiEnabled && !budgetUsed;
  if (canInvestigate && !aiEnabled) notes.push('The AI code check is not part of your plan. Priorities come from the published rules.');
  if (budgetUsed) notes.push("AI code check paused: this month's AI budget is used up. Priorities come from the published rules.");
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
      () => parseLockfileAsync(lockfile), // in a worker thread: a huge lockfile must not freeze other scans
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
        output: `${plural(kev, 'advisory', 'advisories')} on CISA KEV · ${hot} with EPSS ≥ 10%${v.kevDate ? ` · CISA KEV catalog ${v.kevDate}` : ''}`,
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
      // A repository scanned by link belongs to someone else: its vulnera.yml is shown but cannot lower anything.
      () => buildContextAsync({ lockfile, sources, contextFiles, base, truncated, trustDeclarations: !req.repoUrl }, packages),
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
    agent.note('gemini', 'Code check skipped', { output: !sources.length ? 'No source code provided' : !aiEnabled ? 'Not included in your plan' : budgetUsed ? "This month's AI budget is used up" : 'No Gemini key configured' }, 'skipped');
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

  const unverified = st.unverifiedByNetwork;
  if (unverified > 0) {
    notes.push(`${plural(unverified, 'upgrade')} could not be verified because OSV.dev or the npm registry was unreachable; they show "no verified fix" instead of a guess. Scan again on a network that allows them.`);
  }
  const savedNote = savedDataNote(st);
  if (savedNote) notes.push(savedNote);
  if (st.invalidPackages > 0) {
    notes.push(`${plural(st.invalidPackages, 'package name')} in the lockfile ${st.invalidPackages === 1 ? 'is' : 'are'} not valid npm names and ${st.invalidPackages === 1 ? 'was' : 'were'} not looked up.`);
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
  console.error(e); // the real cause stays in the server log
  return { status: 502, error: 'The scan failed on our side. Please try again in a moment.' };
}

// Connection check: which services this server can reach, and what to do about the ones it cannot.
// Open in development; in production it needs the x-admin-token header (see security.ts) and is cached for 60 s.
app.get('/api/doctor', doctorLimiter, async (req, res) => {
  const access = doctorAccess(req);
  if (access === 'not-found') return void res.status(404).json({ error: 'Not found' });
  if (access === 'forbidden') return void res.status(403).json({ error: 'Forbidden' });
  res.json(await runDoctorCached());
});

// Each scan can hold a repository tarball (up to 300 MB unpacked) in memory, so only a few run at once; the rest wait in a fair queue.
const queue = new ScanQueue({
  maxRunning: Math.max(1, envNum('MAX_CONCURRENT_SCANS', 4)),
  maxQueued: Math.max(0, Number(process.env.MAX_QUEUED_SCANS ?? 40) || 0),
  perClient: Math.max(1, envNum('MAX_SCANS_PER_CLIENT', 2)),
});
const DEADLINE_MS = envNum('SCAN_DEADLINE_MS', 180_000);
const BUSY = { status: 429, error: 'Vulnera is busy with other scans right now. Try again in a minute.' };
const CLIENT_BUSY = { status: 429, error: 'You already have scans running. Wait for one to finish.' };
const TIMEOUT = { status: 504, error: 'This scan took longer than 3 minutes and was stopped. Try again, or upload the lockfile instead of a large repository.' };
class DeadlineError extends Error {}

/** Shape and size limits before any work; answers 400/413 with a plain message, or returns the clean request. */
async function checked(req: express.Request, res: express.Response): Promise<ScanRequest | null> {
  try {
    const body = validateScanRequest(req.body);
    if (body.sample) await refund(res); // the sample is never counted
    return body;
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    await refund(res);
    res.status(e.status).json({ error: e.message });
    return null;
  }
}

/**
 * Queue, run and clean up one scan. `finish` is called at most once with the outcome (not when the client is gone).
 * The slot is always released in finally; the deadline starts when the scan gets its slot, not while it waits.
 */
async function runQueued(
  req: express.Request,
  res: express.Response,
  body: ScanRequest,
  abort: AbortController,
  hooks: { onQueue?: (position: number, ahead: number) => void; onStep?: (s: AgentStep) => void; finish: (out: { result: ScanResult } | { status: number; error: string }) => void },
  aiEnabled = true,
) {
  let release: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  const finish = (out: Parameters<typeof hooks.finish>[0]) => {
    if (done || abort.signal.aborted && !(abort.signal.reason instanceof DeadlineError)) return;
    done = true;
    // No result delivered (4xx scan errors, 5xx, deadline): give the scan back before answering.
    if ('error' in out) void refund(res).then(() => hooks.finish(out));
    else hooks.finish(out);
  };
  try {
    release = await req.queueTicket!.slot;
    timer = setTimeout(() => {
      abort.abort(new DeadlineError());
      finish(TIMEOUT); // tell the client now; the slot is freed once the scan actually stops
    }, DEADLINE_MS);
    const result = await scan(body, (st) => !done && hooks.onStep?.(st), abort.signal, aiEnabled);
    await saveResult(res, body, result);
    finish({ result });
  } catch (e) {
    if (abort.signal.reason instanceof DeadlineError) finish(TIMEOUT);
    else if (!abort.signal.aborted) finish(failure(e));
    else if (!release) void refund(res); // left the queue before getting a slot
  } finally {
    clearTimeout(timer);
    release?.();
  }
}

/** Signed-in and key callers get the finished scan saved (never samples); anonymous scans leave no trace. */
async function saveResult(res: express.Response, body: ScanRequest, result: ScanResult) {
  const caller = callerOf(res);
  if (caller.kind === 'anonymous' || body.sample || !dbEnabled()) return;
  try {
    const name = body.meta?.projectName ?? (result.repo ? `${result.repo.owner}/${result.repo.name}` : 'Uploaded lockfile');
    const id = await saveScan(caller.userId, caller.kind === 'key' ? caller.keyId : null, result.repo ? 'repo' : 'upload', name, result);
    if (id) {
      result.scanId = id;
      if (!res.headersSent) res.setHeader('X-Scan-Id', id);
    } else result.notes.push(TOO_BIG_NOTE);
  } catch (e) {
    console.error('[scans] could not save a scan:', e instanceof Error ? e.message : e);
    result.notes.push('This scan could not be saved to your history. The result above is complete.');
  }
}

function join(req: express.Request, res: express.Response, abort: AbortController, onQueue?: (p: number, a: number) => void): boolean {
  try {
    req.queueTicket = queue.join(clientKey(req), abort.signal, onQueue, res.locals.plan?.max_concurrent);
    return true;
  } catch (e) {
    if (!(e instanceof QueueFullError || e instanceof ClientLimitError)) throw e;
    void refund(res);
    const m = e instanceof ClientLimitError ? CLIENT_BUSY : BUSY;
    res.status(m.status).json({ error: m.error });
    return false;
  }
}

// Streams the agent's steps as they happen (one JSON object per line), then the result.
const streamScan: express.RequestHandler = async (req, res) => {
  const body = await checked(req, res);
  if (!body) return;
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort(new Error('client gone'));
  });
  let hb: ReturnType<typeof heartbeat> | undefined;
  const send = (obj: unknown) => {
    if (!res.writableEnded && !res.destroyed) hb?.write(`${JSON.stringify(obj)}\n`);
  };
  if (!join(req, res, abort, (position, ahead) => send({ type: 'queue', position, ahead }))) return;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  hb = heartbeat((line) => {
    if (!res.writableEnded && !res.destroyed) res.write(line);
  });
  const pos = req.queueTicket!.position;
  if (pos > 0) send({ type: 'queue', position: pos, ahead: pos - 1 });
  await runQueued(
    req,
    res,
    body,
    abort,
    {
      onQueue: undefined,
      onStep: (step) => send({ type: 'step', step }),
      finish: (out) => send('result' in out ? { type: 'result', result: out.result } : { type: 'error', ...out }),
    },
    res.locals.plan?.ai_enabled !== false,
  );
  hb.stop();
  res.end();
};

const plainScan: express.RequestHandler = async (req, res) => {
  const body = await checked(req, res);
  if (!body) return;
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort(new Error('client gone'));
  });
  if (!join(req, res, abort)) return;
  await runQueued(
    req,
    res,
    body,
    abort,
    {
      finish: (out) => {
        if ('result' in out) res.json(out.result);
        else res.status(out.status).json({ error: out.error });
      },
    },
    res.locals.plan?.ai_enabled !== false,
  );
};

// Order: who is calling, CSRF, rate limit, quota (before the body is read), body parser, then the handler.
const scanChain = [identify, sameOrigin, scanLimiter, admit, bodyByCaller, anonymousGuard];
app.post('/api/scan/stream', ...scanChain, streamScan);
app.post('/api/scan', ...scanChain, plainScan);
// The same handlers for programs: API key only.
app.post('/v1/scan/stream', identify, requireKeyCaller, ...scanChain.slice(1), streamScan);
app.post('/v1/scan', identify, requireKeyCaller, ...scanChain.slice(1), plainScan);

app.use('/api', sameOrigin); // every other write under /api needs a same-origin browser request (or a Bearer key)
app.use(authRouter());
app.use(keysRouter());
app.use(scansRoutes());

// Production: serve the built client from the same origin (one process to deploy).
const CLIENT_DIST = path.resolve(import.meta.dirname, '../../client/dist');
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  // App routes only (no file extension): a missing /assets/x.js must 404, not return the HTML page.
  app.get(/^\/(?!api\/|auth\/|v1\/)[^.]*$/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

// Last: malformed JSON, oversized bodies and unexpected errors become short JSON answers (no stack traces).
app.use(jsonErrorHandler);

if (dbEnabled() && process.env.MIGRATE_ON_START !== '0') {
  try {
    await migrate();
  } catch (e) {
    console.error(`[db] startup migration failed, not starting: ${e instanceof Error ? e.message : String(e)}`);
    console.error('[db] check DATABASE_URL, or set MIGRATE_ON_START=0 and run "npm run migrate -w server" yourself.');
    process.exit(1);
  }
}

const server = app.listen(PORT, () => {
  console.log(`Vulnera API listening on http://localhost:${PORT}${accountsEnabled() ? ' (accounts on)' : ''}`);
  runDoctor().then(printDoctor).catch(() => {});
  loadKev().catch(() => {}); // read (and, once a day, refresh) the CISA KEV catalog before the first scan
  startSweep();
});

// Clean stop for deploys and restarts: stop taking requests, stop the analysis workers, close the database, then exit.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    const exit = () => process.exit(0);
    shutdownWorkers().then(() => closeDb()).then(exit, exit);
    setTimeout(exit, 5000).unref(); // open streams must not hold the process forever
  });
}

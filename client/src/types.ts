// Copy of server/src/types.ts — keep in sync

// Shared shapes passed between pipeline stages. Each stage owns one file in pipeline/.

export interface Package {
  name: string;
  version: string;
  direct: boolean; // listed in the root package.json
  dev: boolean; // only needed during development
  path: string[]; // chain that pulled it in, e.g. ["express", "body-parser", "qs"]
}

export type Severity = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';

export interface Advisory {
  id: string; // OSV id, e.g. GHSA-xxxx-xxxx-xxxx
  aliases: string[]; // CVE ids etc.
  summary: string;
  details: string;
  severity: Severity;
  fixedVersions: string[]; // first fixed version per affected range
  references: string[];
}

export interface Enrichment {
  epss: number | null; // probability of exploitation in next 30 days; null = no data
  kev: boolean | null; // on CISA KEV; null = no CVE to check
}

export type Tier = 'FIX_NOW' | 'FIX_SPRINT' | 'PLAN' | 'MONITOR';

export interface AiVerdict {
  verdict: 'USES_VULNERABLE_API' | 'NO_VULNERABLE_USAGE_FOUND' | 'UNCERTAIN';
  reasoning: string;
  citations: { file: string; line: number; quote: string }[]; // each quote re-checked against the source file
  vulnerableApis?: string[]; // functions/options the advisory names, as extracted by the AI
}

export interface Finding {
  pkg: Package;
  advisory: Advisory;
  enrichment: Enrichment;
  tier: Tier;
  reasons: string[];
  ai?: AiVerdict;
  exposure?: ExposureVerdict; // architecture context: can an attacker reach this package at all?
}

// ---------- architecture context ----------

// How reachable a package is for an attacker, from the project's own deployment files and code.
// Ordered from most to least exposed. Mapped to CISA SSVC "System Exposure" (open / controlled / small).
export type Exposure = 'public' | 'unknown' | 'login' | 'internal' | 'offline' | 'unreached';

export interface ContextEvidence {
  file: string;
  line: number; // 1-based
  quote: string; // the line, copied from the file
}

export interface ExposureVerdict {
  level: Exposure;
  ssvc: 'open' | 'controlled' | 'small'; // CISA SSVC System Exposure
  vex?: 'vulnerable_code_not_in_execute_path'; // set only for "unreached"
  via: string[]; // components / entry points that load the package
  reason: string; // one plain sentence
  evidence: ContextEvidence[];
  lowered: boolean; // true when this verdict moved the finding down one tier
  openSignup?: ContextEvidence; // "login" that anyone can get: a public sign-up route; never lowers
}

export type ContextFileKind = 'vulnexis' | 'compose' | 'kubernetes' | 'serverless' | 'procfile' | 'dockerfile' | 'openapi' | 'manifest' | 'markdown';

export interface EntryPoint {
  component: string; // e.g. "web" (compose service), "supplier-sync", "package.json main"
  file: string | null; // source file the process starts from, when it is in the scanned code
  exposure: Exposure;
  how: string; // e.g. "docker-compose.yml publishes port 8080"
  evidence: ContextEvidence[];
}

export interface ArchitectureContext {
  files: { path: string; kind: ContextFileKind }[];
  entryPoints: EntryPoint[];
  protectedMounts: { file: string; line: number; prefix: string; guard: string }[]; // routes mounted behind auth middleware
  conflicts: string[]; // places where docs and code/config disagree (the more exposed reading wins)
  openSignup?: ContextEvidence; // public sign-up route: a login wall that anyone can pass
  confident: boolean; // the import graph is complete enough to say "not loaded by any entry point"
  reachedFiles: number;
}

export interface UpgradePlan {
  name: string;
  from: string;
  to: string | null; // null = no verified fix
  jump: 'patch' | 'minor' | 'major' | null;
  command: string | null;
  viaParent?: string; // for transitive packages: direct dependency to upgrade
  parentOnly?: boolean; // an override would be wrong here (copies need different majors, or the package is also a direct dependency): upgrade the parent instead
}

export interface ScanResult {
  scannedAt: string;
  packageCount: number;
  findings: Finding[];
  plans: UpgradePlan[];
  aiStatus: 'ok' | 'disabled' | 'error'; // disabled = no GEMINI_API_KEY or no source provided
  notes: string[]; // non-fatal warnings shown in the UI (e.g. offline cache misses)
  agent?: AgentStep[]; // what the agent did, step by step (tools called, decisions taken, sources)
  repo?: RepoRef; // set when the project was fetched from a public GitHub repository
  context?: ArchitectureContext; // deployment files and entry points found in the project
}

// One step of the agent's run. Each step calls one tool (or decides), and says why.
export type AgentTool = 'plan' | 'github' | 'parse' | 'osv' | 'enrich' | 'context' | 'rank' | 'gemini' | 'verify' | 'report';

export interface AgentSource {
  label: string;
  url: string;
}

export interface AgentStep {
  id: string;
  tool: AgentTool;
  title: string; // what the agent is doing, e.g. "Matching 251 packages against OSV.dev"
  status: 'running' | 'done' | 'skipped' | 'failed';
  startedAt: number; // ms since scan start
  ms?: number; // duration once finished
  input?: string; // what went into the tool (no secrets, no source code)
  output?: string; // what came back, summarised
  decision?: string; // what the agent decided next, and why
  sources?: AgentSource[];
}

export interface RepoRef {
  owner: string;
  name: string;
  ref: string; // branch or commit the files were read from
  url: string;
  lockfilePath: string;
  sourceFiles: number;
  stars?: number; // GitHub stargazers, when the GitHub API answered
  contributors?: number; // GitHub contributors with a GitHub account (what the repo page shows); GitHub stops counting at 500
}

export interface SourceFile {
  path: string; // relative, e.g. "src/routes/notes.js"
  content: string;
}

// POST /api/scan body. Either a lockfile or sample: true (server loads samples/demo-app).
export interface ScanRequest {
  lockfile?: unknown;
  sources?: SourceFile[];
  contextFiles?: SourceFile[]; // deployment and architecture files: YAML, JSON, Markdown, Dockerfile, Procfile
  sourcesTruncated?: boolean; // some source files were left out (limits)
  sample?: boolean;
  repoUrl?: string; // public GitHub repository, e.g. https://github.com/owner/name
}

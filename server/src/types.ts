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
}

export interface UpgradePlan {
  name: string;
  from: string;
  to: string | null; // null = no verified fix
  jump: 'patch' | 'minor' | 'major' | null;
  command: string | null;
  viaParent?: string; // for transitive packages: direct dependency to upgrade
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
}

// One step of the agent's run. Each step calls one tool (or decides), and says why.
export type AgentTool = 'plan' | 'github' | 'parse' | 'osv' | 'enrich' | 'rank' | 'gemini' | 'verify' | 'report';

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
}

export interface SourceFile {
  path: string; // relative, e.g. "src/routes/notes.js"
  content: string;
}

// POST /api/scan body. Either a lockfile or sample: true (server loads samples/demo-app).
export interface ScanRequest {
  lockfile?: unknown;
  sources?: SourceFile[];
  sample?: boolean;
  repoUrl?: string; // public GitHub repository, e.g. https://github.com/owner/name
}

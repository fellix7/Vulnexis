import type { AgentSource, AgentStep, AgentTool } from './types.js';

// Records what the scan agent does, step by step, and streams each change to a listener.
// A step is one tool call or one decision. Nothing secret (keys, source code) is ever put in a step.

export const SOURCES = {
  osv: { label: 'OSV.dev (Google open-source vulnerability database)', url: 'https://osv.dev' },
  epss: { label: 'FIRST EPSS (exploit probability)', url: 'https://www.first.org/epss/' },
  kev: { label: 'CISA Known Exploited Vulnerabilities', url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog' },
  npm: { label: 'npm registry', url: 'https://registry.npmjs.org' },
  gemini: { label: 'Google Gemini (code reading only)', url: 'https://ai.google.dev' },
  github: { label: 'GitHub (public repository)', url: 'https://github.com' },
} satisfies Record<string, AgentSource>;

export type StepPatch = Partial<Pick<AgentStep, 'title' | 'input' | 'output' | 'decision' | 'sources'>>;

export class Agent {
  readonly steps: AgentStep[] = [];
  private readonly t0 = Date.now();
  private seq = 0;

  constructor(private readonly onChange?: (step: AgentStep) => void) {}

  private emit(step: AgentStep) {
    this.onChange?.({ ...step, sources: step.sources ? [...step.sources] : undefined });
  }

  start(tool: AgentTool, title: string, patch: StepPatch = {}): AgentStep {
    const step: AgentStep = { id: `s${++this.seq}`, tool, title, status: 'running', startedAt: Date.now() - this.t0, ...patch };
    this.steps.push(step);
    this.emit(step);
    return step;
  }

  finish(step: AgentStep, status: 'done' | 'skipped' | 'failed', patch: StepPatch = {}) {
    Object.assign(step, patch, { status, ms: Date.now() - this.t0 - step.startedAt });
    this.emit(step);
  }

  /** A decision with no tool call behind it (instant step). */
  note(tool: AgentTool, title: string, patch: StepPatch = {}, status: 'done' | 'skipped' = 'done') {
    this.finish(this.start(tool, title, patch), status);
  }

  /** Run a tool inside a step. The step fails (and the error is rethrown) if the tool throws. */
  async run<T>(tool: AgentTool, title: string, patch: StepPatch, fn: (step: AgentStep) => Promise<T>, after?: (v: T) => StepPatch): Promise<T> {
    const step = this.start(tool, title, patch);
    try {
      const v = await fn(step);
      this.finish(step, 'done', after?.(v));
      return v;
    } catch (e) {
      this.finish(step, 'failed', { output: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

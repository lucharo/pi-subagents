/**
 * agent-model-substitution-note.test.ts — an Agent result says so when the
 * model that ran is not the one asked for.
 *
 * An agent file pinning a model nothing here serves ran, silently, on the
 * session's model, and a `provider/id` whose provider has no sign-in ran under
 * another provider. The caller then read one model's work as another's. The
 * result now starts with a line naming the model that ran.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { modelSubstitutionNote } from "../src/model-resolver.js";

const MODELS = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { provider: "openrouter", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("Agent");
}

/** A parent session on a model of its own: what a pin that resolves to nothing falls back to. */
function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: MODELS[0],
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id)),
      getAvailable: vi.fn(() => MODELS),
    },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

/** The text of an Agent result. */
const text = (result: any): string => result.content.map((c: any) => c.text).join("");

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

/** A real agent file: the Agent tool reloads the registry from `process.cwd()` on every call. */
function pinnedAgent(model: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pinned.md"), `---\ndescription: pins its model\nmodel: ${model}\n---\n\nPinned.\n`);
}

function run(params: Record<string, unknown>) {
  return agentTool().execute("tc", { prompt: "go", description: "d", ...params }, undefined, vi.fn(), ctx());
}

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "agent-model-note-"));
  process.chdir(cwd);
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
    const session = { model: options.model, thinkingLevel: "off", dispose: vi.fn() };
    options.onSessionCreated?.(session);
    return { responseText: "done", session, aborted: false, steered: false } as never;
  });
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  process.chdir(originalCwd);
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  registerAgents(new Map());
  rmSync(cwd, { recursive: true, force: true });
  vi.mocked(runAgent).mockReset();
});

describe("an Agent result says which model ran in place of the one asked for", () => {
  it("names the session's model when an agent file's pin resolves to nothing (foreground)", async () => {
    pinnedAgent("acme/gizmo-9");

    const result = await run({ subagent_type: "pinned", run_in_background: false });

    expect(text(result)).toMatch(
      /^Note: no model "acme\/gizmo-9" is available here, so this ran on the session's model, anthropic\/claude-opus-4-6\.\n\nAgent completed/,
    );
  });

  it("says the same on a background result", async () => {
    pinnedAgent("acme/gizmo-9");

    const result = await run({ subagent_type: "pinned", run_in_background: true });

    expect(text(result)).toMatch(/^Note: no model "acme\/gizmo-9" is available here, .*\n\nAgent (started|queued) in background/);
  });

  it("says it on a failed result too", async () => {
    pinnedAgent("acme/gizmo-9");
    vi.mocked(runAgent).mockRejectedValue(new Error("provider down"));

    const result = await run({ subagent_type: "pinned", run_in_background: false });

    expect(text(result)).toMatch(/^Note: no model "acme\/gizmo-9" is available here, .*\n\nAgent failed: provider down/);
  });

  it("names the provider a provider/id ran under when its own has no sign-in", async () => {
    const result = await run({ subagent_type: "general-purpose", model: "anthropic/claude-haiku-4-5", run_in_background: false });

    expect(vi.mocked(runAgent).mock.calls[0][3].model).toBe(MODELS[1]);
    expect(text(result)).toMatch(
      /^Note: "anthropic\/claude-haiku-4-5" is not available here, so this ran on openrouter\/claude-haiku-4-5\.\n\nAgent completed/,
    );
  });

  it("says nothing when the model asked for is the one that ran", async () => {
    for (const model of ["anthropic/claude-opus-4-6", "haiku"]) {
      const result = await run({ subagent_type: "general-purpose", model, run_in_background: false });
      expect(text(result)).toMatch(/^Agent completed/);
    }
  });
});

describe("modelSubstitutionNote", () => {
  const session = { provider: "anthropic", id: "claude-opus-4-6" };

  it("is undefined for a fuzzy name, another spelling of the id, or the named provider", () => {
    expect(modelSubstitutionNote("haiku", { provider: "openrouter", id: "claude-haiku-4-5" }, session)).toBeUndefined();
    expect(modelSubstitutionNote("Anthropic/claude-opus-4.6", session, session)).toBeUndefined();
  });

  it("is undefined when nothing resolved and there is no session model to fall back to", () => {
    expect(modelSubstitutionNote("acme/gizmo-9", undefined, undefined)).toBeUndefined();
  });
});

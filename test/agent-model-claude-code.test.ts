/**
 * agent-model-claude-code.test.ts: an agent type pinned to a Claude model whose own
 * provider has no sign-in here runs through a Claude Code login (thenewcomputer/fluide-plugins#1043),
 * and the result says which model it ran on.
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

/** A parent session on a model of its own, so "inherited" is a real case. */
function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: { provider: "azure-openai-responses", id: "gpt-5.4", name: "GPT-5.4" },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) =>
        MODELS.find(m => m.provider === provider && m.id === id)),
      getAvailable: vi.fn(() => MODELS),
    },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

/** What a child session reports about itself once pi has resolved it. */
function session(provider: string, id: string, thinkingLevel: string, name?: string) {
  return { model: { provider, id, name: name ?? MODEL_NAMES[id] }, thinkingLevel, dispose: vi.fn() } as never;
}

// signed in only through Claude Code (its aliases, before its own list was fetched) and Azure: no Anthropic key
const MODELS = [
  { provider: "claude-code", id: "opus", name: "Opus" },
  { provider: "claude-code", id: "sonnet", name: "Sonnet" },
  { provider: "azure-openai-responses", id: "gpt-5.4", name: "GPT-5.4" },
];

const MODEL_NAMES: Record<string, string> = Object.fromEntries(MODELS.map(m => [m.id, m.name]));


function pinnedAgent(cwd: string, model: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pinned.md"), `---\ndescription: pins its model\nmodel: ${model}\n---\n\nPinned.\n`);
}

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "agent-model-claude-code-"));
  process.chdir(cwd);
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
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
  vi.restoreAllMocks();
});

async function runPinned(model: string) {
  pinnedAgent(cwd, model);
  let ranOn: any;
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
    ranOn = options.model;
    const s = session(options.model.provider, options.model.id, "medium");
    options.onSessionCreated?.(s);
    return { responseText: "done", session: s, aborted: false, steered: false } as never;
  });
  const result = await agentTool().execute("tc-1", { prompt: "go", description: "d", subagent_type: "pinned", run_in_background: false }, undefined, vi.fn(), ctx());
  return { ranOn, text: result.content[0].text as string };
}

describe("Agent tool — a pinned Claude model on a Claude Code login", () => {
  it("an Anthropic API id runs on Claude Code's model of the same family, and says so", async () => {
    const { ranOn, text } = await runPinned("anthropic-vertex/claude-sonnet-4-6");
    expect(ranOn).toMatchObject({ provider: "claude-code", id: "sonnet" });
    expect(text.startsWith('Note: no model "anthropic-vertex/claude-sonnet-4-6" is available here, so this ran on claude-code/sonnet, the same Claude family (sonnet).')).toBe(true);
  });

  it("a pinned model that matches nothing still runs on the session's model, and now says so", async () => {
    const { ranOn, text } = await runPinned("google/gemini-2.5-pro");
    expect(ranOn).toMatchObject({ provider: "azure-openai-responses", id: "gpt-5.4" });
    expect(text.startsWith('Note: no model "google/gemini-2.5-pro" is available here, so this ran on the session\'s model, azure-openai-responses/gpt-5.4.')).toBe(true);
  });

  it("a model that resolves as asked carries no note", async () => {
    const { ranOn, text } = await runPinned("claude-code/opus");
    expect(ranOn).toMatchObject({ provider: "claude-code", id: "opus" });
    expect(text.startsWith("Agent completed")).toBe(true);
  });
});

/**
 * workflow-handoff.test.ts — when a `SubagentWorkflow` call stops holding its result.
 *
 * The call returns at the first of: a live agent starting, the run settling, or
 * the handoff window passing. workflow-tool.test.ts covers the settle and the
 * window; this covers the half that needs a real agent spawn: a live agent ends
 * the wait at once however long the window is, and an agent replayed from a
 * resume journal does not, so a resumed script that throws after its replays
 * still fails inside the tool result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { workflowHandoff } from "../src/workflow/task.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const fakeSession = () => ({
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  messages: [],
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
});

const meta = 'export const meta = { name: "wf", description: "d" };\n';

describe("SubagentWorkflow handoff to the background", () => {
  let hermetic: Hermetic;
  const handoffMs = workflowHandoff.ms;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { workflowsEnabled: true } });
    // A window far longer than any test: only a live agent or a settle can end the wait.
    workflowHandoff.ms = 60_000;
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      const session = fakeSession();
      opts.onSessionCreated?.(session as any);
      return { responseText: "child done", session: session as any, aborted: false, steered: false };
    });
  });
  afterEach(() => {
    workflowHandoff.ms = handoffMs;
    vi.mocked(runAgent).mockReset();
    hermetic.restore();
  });

  function boot() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const run = (id: string, params: Record<string, unknown>) =>
      booted.tools.get("SubagentWorkflow").execute(id, params, undefined, undefined, ctx({ cwd: hermetic.dir }));
    return { ...booted, run };
  }

  it("hands off as soon as the first live agent starts", async () => {
    const { pi, run } = boot();
    const started = Date.now();
    const result = await run("tc-live", { script: `${meta}return await agent("read the routes");\n` });

    expect(textOf(result)).toMatch(/started in the background/);
    expect(Date.now() - started).toBeLessThan(10_000);
    // The run carries on without the call and reports back on its own.
    await vi.waitFor(
      () => expect(pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes("child done"))).toBe(true),
      { timeout: 10_000 },
    );
  });

  it("does not hand off on replayed agents, so a resumed script that throws fails in the result", async () => {
    const { pi, run } = boot();
    const first = await run("tc-first", { script: `${meta}return await agent("read the routes");\n` });
    const firstId = (first.details as { taskId: string }).taskId;
    await vi.waitFor(
      () => expect(pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(firstId))).toBe(true),
      { timeout: 10_000 },
    );

    // Same first call, so it replays from the journal; then the edited script throws.
    const result = await run("tc-resume", {
      script: `${meta}const r = await agent("read the routes");\nthrow new Error("bad merge step");\n`,
      resumeFromRunId: firstId,
    });

    const text = textOf(result);
    expect(text).toMatch(/failed after/);
    expect(text).toContain("bad merge step");
    expect(text).toMatch(/Replayed 1 recorded call/);
    expect(text).toMatch(/resumeFromRunId: "wf_/);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

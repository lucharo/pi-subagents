/**
 * dead-agents-wiring.test.ts — a dead workflow agent and a dead workflow run,
 * through the real extension.
 *
 * dead-agents.test.ts covers the manager's stall check; this covers what the
 * session sees: the parent is told when a workflow's agent stops responding,
 * the run goes on with that agent failed, a run with nothing in flight that
 * stops moving settles as failed and drops off the running list, and another
 * extension can stop a run or one of its agents over pi.events.
 *
 * Only setInterval and Date are faked, with real time still passing: the
 * workflow script runs in a worker thread, which keeps its own clock, and the
 * runtime's messages to and from it must keep flowing while the test jumps the
 * main thread an hour ahead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { workflowHandoff } from "../src/workflow/task.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MINUTE = 60_000;
const meta = 'export const meta = { name: "audit", description: "d" };\n';
const MANAGER = Symbol.for("pi-subagents:manager");

const fakeSession = () => ({
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  messages: [],
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
});

describe("dead workflow agents and runs, through the extension", () => {
  let hermetic: Hermetic;
  const handoffMs = workflowHandoff.ms;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    hermetic = hermeticDir({ settings: { workflowsEnabled: true } });
    workflowHandoff.ms = 20;
  });
  afterEach(async () => {
    workflowHandoff.ms = handoffMs;
    vi.mocked(runAgent).mockReset();
    vi.useRealTimers();
    hermetic.restore();
  });

  async function boot() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const c = ctx({ cwd: hermetic.dir });
    await booted.lifecycle.get("session_start")?.({}, c);
    const run = (id: string, script: string) =>
      booted.tools.get("SubagentWorkflow").execute(id, { script }, undefined, undefined, c);
    const registry = () => (globalThis as any)[MANAGER];
    /** The handler the extension registered on pi.events for `channel`. */
    const handler = (channel: string) => booted.pi.events.on.mock.calls.find((call: any[]) => call[0] === channel)?.[1];
    const shutdown = () => booted.lifecycle.get("session_shutdown")?.({}, c);
    const said = (re: RegExp) => booted.pi.sendMessage.mock.calls.filter((call: any[]) => re.test(String(call[0]?.content)));
    return { ...booted, run, registry, handler, shutdown, said };
  }

  it("tells the parent when a workflow agent stops responding, and the run goes on without it", async () => {
    // The first agent wedges; the second answers.
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, prompt: string, opts: any) => {
      const session = fakeSession();
      opts.onSessionCreated?.(session as any);
      if (prompt === "verify") return new Promise(() => {});
      return { responseText: "summary", session: session as any, aborted: false, steered: false };
    });
    const b = await boot();
    try {
      const result = await b.run("tc-1", `${meta}const v = await agent("verify", { label: "verify:6" });\nreturn String(v) + " / " + await agent("summarise");\n`);
      const runId = (result.details as { taskId: string }).taskId;
      await vi.waitFor(() => expect(b.registry().hasRunning()).toBe(true));

      await vi.advanceTimersByTimeAsync(61 * MINUTE);

      // The parent hears about the dead agent while the run carries on.
      await vi.waitFor(() => expect(b.said(/agent "verify:6" stopped responding/)).toHaveLength(1));
      const [message, options] = b.said(/agent "verify:6" stopped responding/)[0];
      expect(message.content).toContain(`Workflow "audit" (${runId})`);
      expect(message.details).toMatchObject({ status: "error", error: "Stopped responding: nothing written for 60 min." });
      expect(options).toMatchObject({ triggerTurn: true });

      // agent() returned null for it, and the run finished on the next agent.
      await vi.waitFor(() => expect(b.said(/null \/ summary/)).toHaveLength(1), { timeout: 10_000 });
      const snap = b.registry().listWorkflows().find((r: any) => r.id === runId);
      expect(snap.status).toBe("completed");
      expect(snap.agents.find((a: any) => a.label === "verify:6")).toMatchObject({
        state: "failed",
        error: "Stopped responding: nothing written for 60 min.",
      });
      expect(b.registry().hasRunning()).toBe(false);
      expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:stalled", expect.objectContaining({ workflowId: runId }));
    } finally {
      await b.shutdown();
    }
  });

  it("fails a run that stops moving with nothing in flight, so it no longer counts as running", async () => {
    const b = await boot();
    try {
      // Spins: no agent, no progress, never returns.
      const result = await b.run("tc-2", `${meta}for (;;) {}\n`);
      const runId = (result.details as { taskId: string }).taskId;
      const status = () => b.registry().listWorkflows().find((r: any) => r.id === runId)?.status;
      expect(status()).toBe("running");

      await vi.advanceTimersByTimeAsync(59 * MINUTE);
      expect(status()).toBe("running");

      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      await vi.waitFor(() => expect(status()).toBe("failed"), { timeout: 10_000 });
      const snap = b.registry().listWorkflows().find((r: any) => r.id === runId);
      expect(snap.error).toBe("Workflow stopped responding: nothing written for 60 min.");
      // The parent gets the usual finished-run notification, reading as a failure.
      await vi.waitFor(() => expect(b.said(/Workflow stopped responding/)).toHaveLength(1), { timeout: 10_000 });
    } finally {
      await b.shutdown();
    }
  });

  it("stops a run, or one of its agents, over subagents:rpc:workflow-stop", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: string, opts: any) => {
      opts.onSessionCreated?.(fakeSession() as any);
      // A child that winds down when stopped, as a healthy one does.
      return new Promise(resolve =>
        opts.signal.addEventListener("abort", () => resolve({ responseText: "", session: fakeSession() as any, aborted: true, steered: false })),
      );
    });
    const b = await boot();
    try {
      const result = await b.run("tc-3", `${meta}const a = await agent("one");\nawait agent("two");\nreturn "end";\n`);
      const runId = (result.details as { taskId: string }).taskId;
      const stop = b.handler("subagents:rpc:workflow-stop");
      expect(stop).toBeTypeOf("function");
      const ask = async (params: Record<string, unknown>) => {
        const requestId = `r${Math.random()}`;
        await stop({ requestId, ...params });
        const reply = b.pi.events.emit.mock.calls.find((call: any[]) => call[0] === `subagents:rpc:workflow-stop:reply:${requestId}`);
        return reply?.[1];
      };
      const snap = () => b.registry().listWorkflows().find((r: any) => r.id === runId);

      await vi.waitFor(() => expect(snap().agents[0]?.state).toBe("running"));
      expect(await ask({ runId, index: 0 })).toEqual({ success: true });
      // Skipped: the run moves on to its second agent.
      await vi.waitFor(() => expect(snap().agents[1]?.state).toBe("running"), { timeout: 10_000 });
      expect(snap().agents[0].state).toBe("skipped");

      expect(await ask({ runId })).toEqual({ success: true });
      await vi.waitFor(() => expect(snap().status).toBe("killed"), { timeout: 10_000 });
      expect(await ask({ runId })).toEqual({ success: false, error: "Workflow is not running" });
      expect(await ask({ runId: "wf_nosuchrun" })).toEqual({ success: false, error: "Workflow not found" });
    } finally {
      await b.shutdown();
    }
  });
});

// An agent whose run never ends used to show "running" for good: a workflow row
// read "Running · 75h", `hasRunning()` stayed true (so a session restart waited
// on it), and its awaiter (a workflow's agent(), a foreground Agent call) never
// returned. The manager now settles a run that has written nothing for the
// stall limit as failed ("Stopped responding"), and a stopped run that ignored
// its stop after a short grace.
//
// Fake timers go in BEFORE `new AgentManager()` (as in agent-manager-gc.test.ts):
// the constructor starts the minute tick that runs the check, and advancing the
// timers moves Date.now() with it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));
// A worktree's wind-down (gate, cleanup) is where a finished run can hang; the
// real git calls are not what these tests are about.
vi.mock("../src/worktree.js", () => ({
  isWorktreeIsolationEnabled: () => true,
  createWorktree: vi.fn(async () => ({ path: "/tmp/wt", branch: "b", baseSha: "s", workPath: "/tmp/wt" })),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
}));

import { AgentManager, DEFAULT_STALL_LIMIT_MS, STOP_GRACE_MS, stalledMessage, WIND_DOWN_FLOOR_MS } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost, DEFAULT_GATE_TIMEOUT_MS } from "../src/workflow/host.js";
import { cleanupWorktree } from "../src/worktree.js";
import { ctx } from "./helpers/boot-extension.js";

const MINUTE = 60_000;
const mockPi = {} as any;

/** A session whose subscribers the test can poke, as a streaming one would. */
function liveSession() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    dispose: vi.fn(),
    messages: [],
    subscribe: vi.fn((fn: (e: unknown) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    emit: (e: unknown) => { for (const fn of listeners) fn(e); },
  };
}

/** Deferred result for a run the test settles by hand (or never). */
function deferredRun() {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>(r => { resolve = r; });
  return { promise, resolve };
}

describe("a run that stops responding is settled as failed", () => {
  let manager: AgentManager;
  let completed: AgentRecord[];
  let stalled: AgentRecord[];

  beforeEach(() => {
    vi.useFakeTimers();
    registerAgents(new Map());
    completed = [];
    stalled = [];
    manager = new AgentManager(record => { completed.push({ ...record }); });
    manager.setOnStalled(record => stalled.push(record));
  });

  afterEach(async () => {
    await manager.dispose();
    vi.useRealTimers();
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  it("marks a silent background agent failed after the limit, frees its slot and notifies once", async () => {
    // Never settles, never writes: the wedged-stream case.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.setMaxConcurrent(1);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "audit", { description: "audit", isBackground: true });
    const next = manager.spawn(mockPi, ctx(), "general-purpose", "next", { description: "next", isBackground: true });
    expect(manager.getRecord(next)?.status).toBe("queued");

    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS - MINUTE);
    expect(manager.getRecord(id)?.status).toBe("running");
    expect(stalled).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("error");
    expect(record.error).toBe(stalledMessage(DEFAULT_STALL_LIMIT_MS));
    expect(record.error).toMatch(/^Stopped responding: nothing written for 60 min\.$/);
    expect(record.abortController?.signal.aborted).toBe(true);
    expect(stalled.map(r => r.id)).toEqual([id]);
    expect(completed.filter(r => r.id === id)).toHaveLength(1);
    // The slot it held went to the queued agent.
    expect(manager.getRecord(next)?.status).toBe("running");
    // Waiters let go too.
    await expect(record.promise).resolves.toBe("");
  });

  it("counts tool activity and usage as signs of life", async () => {
    let opts: any;
    vi.mocked(runAgent).mockImplementation((_c, _t, _p, o: any) => {
      opts = o;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "long", { description: "long", isBackground: true });

    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    opts.onToolActivity({ type: "start", toolName: "bash" });
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    opts.onAssistantUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(manager.getRecord(id)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(manager.getRecord(id)?.status).toBe("error");
  });

  it("counts any event its session emits as a sign of life", async () => {
    const session = liveSession();
    vi.mocked(runAgent).mockImplementation((_c, _t, _p, o: any) => {
      o.onSessionCreated(session);
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "stream", { description: "stream", isBackground: true });

    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    session.emit({ type: "message_update" });
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(manager.getRecord(id)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(manager.getRecord(id)?.status).toBe("error");
  });

  it("does not settle twice when the run ends after the check settled it", async () => {
    const run = deferredRun();
    vi.mocked(runAgent).mockImplementation(() => run.promise);
    manager.setMaxConcurrent(1);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "late", { description: "late", isBackground: true });

    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);
    expect(manager.getRecord(id)?.status).toBe("error");

    // The stream comes back after all.
    run.resolve({ responseText: "finally", session: { dispose: vi.fn() }, aborted: false, steered: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getRecord(id)?.status).toBe("error");
    expect(manager.getRecord(id)?.error).toBe(stalledMessage(DEFAULT_STALL_LIMIT_MS));
    expect(completed.filter(r => r.id === id)).toHaveLength(1);
    // One slot: a double release would let two agents run at once.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const a = manager.spawn(mockPi, ctx(), "general-purpose", "a", { description: "a", isBackground: true });
    const b = manager.spawn(mockPi, ctx(), "general-purpose", "b", { description: "b", isBackground: true });
    expect(manager.getRecord(a)?.status).toBe("running");
    expect(manager.getRecord(b)?.status).toBe("queued");
  });

  it("stops counting it as running, so a restart is no longer held up", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, ctx(), "general-purpose", "audit", { description: "audit", isBackground: true });
    expect(manager.hasRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);
    expect(manager.hasRunning()).toBe(false);
  });

  it("follows the configured limit, and 0 turns the check off", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.setStallLimitMs(5 * MINUTE);
    const quick = manager.spawn(mockPi, ctx(), "general-purpose", "q", { description: "q", isBackground: true });
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(manager.getRecord(quick)?.error).toBe("Stopped responding: nothing written for 5 min.");

    manager.setStallLimitMs(0);
    const kept = manager.spawn(mockPi, ctx(), "general-purpose", "k", { description: "k", isBackground: true });
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(manager.getRecord(kept)?.status).toBe("running");
  });

  it("settles a stopped agent whose run ignored the stop, after a short grace", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "deaf", { description: "deaf", isBackground: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.abort(id)).toBe(true);
    expect(completed).toEqual([]);

    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + MINUTE);
    expect(manager.getRecord(id)?.status).toBe("stopped");
    expect(completed.map(r => r.id)).toEqual([id]);
    // A stop is not a stall: nobody is told it "stopped responding".
    expect(stalled).toEqual([]);
  });

  it("lets a workflow's agent() return a failure when its child stops responding", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf_dead01" });
    const pending = host.spawnAgent({ agentId: "wf-agent-6", index: 6, prompt: "verify", label: "verify:6", agentType: "general-purpose" });

    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);

    await expect(pending).resolves.toMatchObject({ ok: false, error: stalledMessage(DEFAULT_STALL_LIMIT_MS) });
    expect(stalled.map(r => r.workflowId)).toEqual(["wf_dead01"]);
  });

  it("lets a workflow's skip land on a child whose run ignores the stop", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf_dead01" });
    const pending = host.spawnAgent({ agentId: "wf-agent-2", index: 2, prompt: "p", label: "p", agentType: "general-purpose" });
    await vi.advanceTimersByTimeAsync(0);

    host.abortAgent("wf-agent-2");
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + MINUTE);

    await expect(pending).resolves.toMatchObject({ ok: false, skipped: true });
  });

  it("settles a foreground resume that stops responding", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: liveSession(), aborted: false, steered: false } as any);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "p", { description: "p", isBackground: true });
    await manager.getRecord(id)!.promise;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));

    const resumed = manager.resume(id, "again");
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);

    await expect(resumed).resolves.toMatchObject({ status: "error", error: stalledMessage(DEFAULT_STALL_LIMIT_MS) });
  });

  it("reaches a foreground resume with abort(), not the finished run's controller", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: liveSession(), aborted: false, steered: false } as any);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "p", { description: "p", isBackground: true });
    await manager.getRecord(id)!.promise;
    let signal: AbortSignal | undefined;
    vi.mocked(resumeAgent).mockImplementation((_s, _p, o: any) => {
      signal = o.signal;
      return new Promise(resolve => o.signal.addEventListener("abort", () => resolve({ text: "cut short" })));
    });

    const resumed = manager.resume(id, "again");
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.abort(id)).toBe(true);

    expect(signal?.aborted).toBe(true);
    // The stop is kept rather than overwritten as a completion.
    await expect(resumed).resolves.toMatchObject({ status: "stopped", result: "cut short" });
  });

  it("settles a detached resume that stops responding, through the normal notification", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: liveSession(), aborted: false, steered: false } as any);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "p", { description: "p", isBackground: true });
    await manager.getRecord(id)!.promise;
    completed = [];
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));

    await manager.resume(id, "again", undefined, { isBackground: true });
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);

    expect(manager.getRecord(id)).toMatchObject({ status: "error", error: stalledMessage(DEFAULT_STALL_LIMIT_MS) });
    expect(completed.map(r => r.id)).toEqual([id]);
    await expect(manager.getRecord(id)!.promise).resolves.toBe("");
  });

  it("publishes a foreground resume's own turn as record.promise, so waiters wait on it", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: liveSession(), aborted: false, steered: false } as any);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "p", { description: "p", isBackground: true });
    await manager.getRecord(id)!.promise;
    const turn = deferredRun();
    vi.mocked(resumeAgent).mockImplementation(() => turn.promise);

    const resumed = manager.resume(id, "again");
    let settled = false;
    void manager.getRecord(id)!.promise!.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    turn.resolve({ text: "second" });
    await resumed;
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(manager.getRecord(id)!.promise).resolves.toBe("second");
  });

  it("keeps a parent alive while a nested child it waits on is working", async () => {
    let childOpts: any;
    vi.mocked(runAgent).mockImplementation((_c, _t, prompt, o: any) => {
      if (prompt === "child") childOpts = o;
      return new Promise(() => {});
    });
    const parent = manager.spawn(mockPi, ctx(), "general-purpose", "parent", { description: "parent", isBackground: true });
    const child = manager.spawn(mockPi, ctx(), "general-purpose", "child", { description: "child", parentAgentId: parent });

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(50 * MINUTE);
      childOpts.onToolActivity({ type: "end", toolName: "bash" });
    }
    expect(manager.getRecord(parent)?.status).toBe("running");
    expect(manager.getRecord(child)?.status).toBe("running");

    // Once the child goes silent too, the parent is found out, and its child
    // stops with it (whichever the sweep reached first).
    await vi.advanceTimersByTimeAsync(61 * MINUTE);
    expect(manager.getRecord(parent)?.status).toBe("error");
    expect(manager.getRecord(child)?.status).not.toBe("running");
  });

  it("waits out a gate before settling a finished run whose wind-down hangs, then settles it as a failure", async () => {
    expect(WIND_DOWN_FLOOR_MS).toBeGreaterThanOrEqual(2 * DEFAULT_GATE_TIMEOUT_MS);
    manager.setStallLimitMs(5 * MINUTE);
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: liveSession(), aborted: false, steered: false } as any);
    vi.mocked(cleanupWorktree).mockImplementationOnce(() => new Promise(() => {}));
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf_gate01" });
    let ok: boolean | undefined;
    const pending = host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "fix", label: "fix", agentType: "general-purpose", isolation: "worktree" })
      .then(r => { ok = r.ok; return r; });

    // Longer than the 5-minute limit, shorter than a gate may take: left alone.
    await vi.advanceTimersByTimeAsync(WIND_DOWN_FLOOR_MS - MINUTE);
    expect(ok).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    // A failure, not the success it had: a success would run the gate again.
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/^Stopped responding: its wind-down/) });
    expect(stalled).toEqual([]);
  });

  it("marks a foreground resume stopped when its caller's signal aborts, already or mid-turn", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: liveSession(), aborted: false, steered: false } as any);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "p", { description: "p", isBackground: true });
    await manager.getRecord(id)!.promise;
    vi.mocked(resumeAgent).mockImplementation((_s, _p, o: any) =>
      o.signal.aborted ? Promise.resolve({ text: "" }) : new Promise(resolve => o.signal.addEventListener("abort", () => resolve({ text: "partial" }))));

    await expect(manager.resume(id, "again", AbortSignal.abort())).resolves.toMatchObject({ status: "stopped" });

    const caller = new AbortController();
    const resumed = manager.resume(id, "again", caller.signal);
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    await expect(resumed).resolves.toMatchObject({ status: "stopped", result: "partial" });
  });

  it("shuts down a session that arrives after its run was settled and its record cleaned up", async () => {
    let opts: any;
    vi.mocked(runAgent).mockImplementation((_c, _t, _p, o: any) => { opts = o; return new Promise(() => {}); });
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "slow start", { description: "s", isBackground: true });
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);
    expect(manager.getRecord(id)?.status).toBe("error");
    await vi.advanceTimersByTimeAsync(11 * MINUTE); // the ten-minute cleanup takes the record
    expect(manager.getRecord(id)).toBeUndefined();

    const emit = vi.fn(async () => {});
    const late = { ...liveSession(), extensionRunner: { hasHandlers: () => true, emit } };
    opts.onSessionCreated(late);
    await vi.advanceTimersByTimeAsync(0);

    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(late.dispose).toHaveBeenCalled();
    expect(late.subscribe).not.toHaveBeenCalled();
  });

  it("applies a workflow's skip that arrived while its child was still starting", async () => {
    let releaseWorktree!: () => void;
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockImplementationOnce(() => new Promise(resolve => {
      releaseWorktree = () => resolve({ path: "/tmp/wt", branch: "b", baseSha: "s", workPath: "/tmp/wt" });
    }));
    vi.mocked(runAgent).mockImplementation((_c, _t, _p, o: any) =>
      new Promise(resolve => o.signal.addEventListener("abort", () => resolve({ responseText: "", session: liveSession(), aborted: true, steered: false }))));
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf_start01" });
    const pending = host.spawnAgent({ agentId: "wf-agent-0", index: 0, prompt: "p", label: "p", agentType: "general-purpose", isolation: "worktree" });
    await vi.advanceTimersByTimeAsync(0);

    host.abortAgent("wf-agent-0"); // no manager id yet
    releaseWorktree();

    await expect(pending).resolves.toMatchObject({ ok: false, skipped: true });
  });

  it("fails a gate whose command never exits, a minute past its timeout", async () => {
    const pi = { exec: vi.fn(() => new Promise(() => {})) } as any;
    const host = createWorkflowHost({ pi, ctx: ctx(), manager, gateTimeoutMs: 5 * MINUTE });
    const gate = host.runGate!("npm test", { agentId: "wf-agent-0" });
    let out: any;
    void gate.then(r => { out = r; });
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 59_000);
    expect(out).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(out).toEqual({ ok: false, output: "Gate command did not exit after its timeout: npm test" });
  });
});

// An agent whose run never ends (a wedged provider stream, a stop it ignores)
// used to read "running" for good: its slot stayed taken, `hasRunning()` stayed
// true, and whoever awaited it (a workflow's agent(), a foreground Agent call)
// never returned. The manager now settles a run that has written nothing for
// the stall limit as failed ("Stopped responding"), and a stopped run that
// ignored its stop after a short grace.
//
// Fake timers go in BEFORE `new AgentManager()` (as in agent-manager-gc.test.ts):
// the constructor starts the minute tick that runs the check, and advancing the
// timers moves Date.now() with it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  isWorktreeIsolationEnabled: () => true,
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
}));

import { AgentManager, DEFAULT_STALL_LIMIT_MS, STOP_GRACE_MS, stalledMessage } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { ctx } from "./helpers/boot-extension.js";

const MINUTE = 60_000;
const mockPi = {} as any;
const STALLED = stalledMessage(DEFAULT_STALL_LIMIT_MS);

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

/** A run the test settles by hand, or never. */
function deferredRun() {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>(r => { resolve = r; });
  return { promise, resolve };
}

const finished = (responseText: string) =>
  ({ responseText, session: liveSession(), aborted: false, steered: false }) as any;

describe("a run that stops responding is settled as failed", () => {
  let manager: AgentManager;
  let completed: AgentRecord[];

  beforeEach(() => {
    vi.useFakeTimers();
    registerAgents(new Map());
    completed = [];
    manager = new AgentManager(record => { completed.push({ ...record }); });
  });

  afterEach(async () => {
    await manager.dispose();
    vi.useRealTimers();
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  /** Spawn a background agent that finishes at once, ready to be resumed. */
  async function finishedAgent(): Promise<string> {
    vi.mocked(runAgent).mockResolvedValue(finished("first"));
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "p", { description: "p", isBackground: true });
    await manager.getRecord(id)!.promise;
    completed = [];
    return id;
  }

  it("marks a silent background agent failed after the limit, frees its slot and notifies once", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.setMaxConcurrent(1);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "audit", { description: "audit", isBackground: true });
    const next = manager.spawn(mockPi, ctx(), "general-purpose", "next", { description: "next", isBackground: true });
    expect(manager.getRecord(next)?.status).toBe("queued");

    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS - MINUTE);
    expect(manager.getRecord(id)?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("error");
    expect(record.error).toBe("Stopped responding: nothing written for 60 min.");
    expect(record.abortController?.signal.aborted).toBe(true);
    expect(completed.filter(r => r.id === id)).toHaveLength(1);
    // Its slot went to the queued agent, and its awaiters were let go.
    expect(manager.getRecord(next)?.status).toBe("running");
    await expect(record.promise).resolves.toBe("");
    expect(manager.isSettling(id)).toBe(false);
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
    opts.onAssistantUsage({ input: 1, output: 1, cacheWrite: 0 });
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
    run.resolve(finished("finally"));
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.getRecord(id)).toMatchObject({ status: "error", error: STALLED });
    expect(manager.getRecord(id)?.result).toBeUndefined();
    expect(completed.filter(r => r.id === id)).toHaveLength(1);
    // One slot: a double release would let two agents run at once.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const a = manager.spawn(mockPi, ctx(), "general-purpose", "a", { description: "a", isBackground: true });
    const b = manager.spawn(mockPi, ctx(), "general-purpose", "b", { description: "b", isBackground: true });
    expect(manager.getRecord(a)?.status).toBe("running");
    expect(manager.getRecord(b)?.status).toBe("queued");
  });

  it("stops counting it as running", async () => {
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
    await expect(manager.getRecord(id)!.promise).resolves.toBe("");
  });

  it("lets a workflow's agent() return a failure when its child stops responding", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf_dead01" });
    const pending = host.spawnAgent({ agentId: "wf-agent-6", index: 6, prompt: "verify", label: "verify:6", agentType: "general-purpose" });

    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);

    await expect(pending).resolves.toMatchObject({ ok: false, error: STALLED });
  });

  it("returns a foreground resume that stops responding, marked failed", async () => {
    const id = await finishedAgent();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));

    const resumed = manager.resume(id, "again");
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);

    await expect(resumed).resolves.toMatchObject({ status: "error", error: STALLED });
  });

  it("settles a detached resume that stops responding, through the normal notification", async () => {
    const id = await finishedAgent();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}));

    await manager.resume(id, "again", undefined, { isBackground: true });
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);

    expect(manager.getRecord(id)).toMatchObject({ status: "error", error: STALLED });
    expect(completed.map(r => r.id)).toEqual([id]);
    await expect(manager.getRecord(id)!.promise).resolves.toBe("");
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
    // stops with it.
    await vi.advanceTimersByTimeAsync(61 * MINUTE);
    expect(manager.getRecord(parent)?.status).toBe("error");
    expect(manager.getRecord(child)?.status).not.toBe("running");
  });

  it("shuts down a session that arrives after its run was settled and its record cleaned up", async () => {
    let opts: any;
    vi.mocked(runAgent).mockImplementation((_c, _t, _p, o: any) => { opts = o; return new Promise(() => {}); });
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "slow start", { description: "s", isBackground: true });
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);
    expect(manager.getRecord(id)?.status).toBe("error");
    await vi.advanceTimersByTimeAsync(11 * MINUTE); // the ten-minute cleanup takes the record
    expect(manager.getRecord(id)).toBeUndefined();

    const late = liveSession();
    opts.onSessionCreated(late);
    await vi.advanceTimersByTimeAsync(0);

    expect(late.dispose).toHaveBeenCalled();
    expect(late.subscribe).not.toHaveBeenCalled();
  });

  it("a settled run that ends late does not write over the resume that followed it", async () => {
    const session = liveSession();
    const run = deferredRun();
    vi.mocked(runAgent).mockImplementation((_c, _t, _p, o: any) => { o.onSessionCreated(session); return run.promise; });
    const turn = deferredRun();
    vi.mocked(resumeAgent).mockImplementation(() => turn.promise);
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "p", { description: "p", isBackground: true });
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_LIMIT_MS + MINUTE);
    expect(manager.getRecord(id)?.status).toBe("error");

    const resumed = manager.resume(id, "again");
    await vi.advanceTimersByTimeAsync(0);
    const streamOfResume = vi.fn();
    manager.getRecord(id)!.outputCleanup = streamOfResume;

    run.resolve({ responseText: "late spawn text", session, aborted: false, steered: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getRecord(id)).toMatchObject({ status: "running" });
    expect(manager.getRecord(id)?.result).toBeUndefined();
    expect(streamOfResume).not.toHaveBeenCalled();

    turn.resolve({ text: "second" });
    await expect(resumed).resolves.toMatchObject({ status: "completed", result: "second" });
  });
});

// #4: a workflow run held every child's whole live AgentSession until the run
// ended. A 529-child run kept its parent Pi at 1.4 to 2.1 GB and 67 to 85% CPU:
// each finished child's extensions (a tasks extension re-serialising a ~1 MB
// snapshot about every second) went on running. A settled child now has its
// session shut down and keeps only its record; a later `agent({ resume })`
// reopens its session file.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return { ...actual, createWorktree: vi.fn(), cleanupWorktree: vi.fn() };
});

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { workflowHandoff } from "../src/workflow/task.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const mockPi = {} as any;

/** A real session file: a resume reopens it, and refuses one that is gone. */
const SESSION_DIR = mkdtempSync(join(tmpdir(), "child-release-"));
const SESSION_FILE = join(SESSION_DIR, "child.jsonl");
writeFileSync(SESSION_FILE, "");

/**
 * A child session as `runAgent` leaves it: extensions bound (a runner that
 * handles `session_shutdown`), a session file, and real listener bookkeeping,
 * so a test can see whether anything is still subscribed to it.
 */
function childSession(sessionFile: string | null = SESSION_FILE) {
  const listeners = new Set<(event: unknown) => void>();
  const session = {
    listeners,
    disposed: false,
    messages: [] as unknown[],
    sessionManager: { getSessionFile: () => sessionFile ?? undefined },
    /** One per subscription; each must be called, since a held unsubscribe closure keeps the session reachable. */
    unsubscribes: [] as ReturnType<typeof vi.fn>[],
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener);
      const off = vi.fn(() => { listeners.delete(listener); });
      session.unsubscribes.push(off);
      return off;
    }),
    extensionRunner: {
      hasHandlers: vi.fn((event: string) => event === "session_shutdown"),
      emit: vi.fn(async () => {}),
    },
    dispose: vi.fn(() => {
      session.disposed = true;
      listeners.clear();
    }),
  };
  return session;
}
type ChildSession = ReturnType<typeof childSession>;

/** Every session the mocked `runAgent` handed out, in order. */
let sessions: ChildSession[];

/**
 * `runAgent` as the real one behaves for these purposes: the session appears
 * after a tick, the turn reports its usage, and the call resolves with the text.
 */
function mockRunAgent(opts: { sessionFile?: string | null; text?: (prompt: string, resumed: boolean) => string } = {}) {
  vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, prompt: string, options: any) => {
    const session = childSession(opts.sessionFile);
    sessions.push(session);
    await new Promise(resolve => setImmediate(resolve));
    options.onSessionCreated?.(session);
    options.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0 });
    return {
      responseText: opts.text?.(prompt, options.resumeSessionFile !== undefined) ?? `done: ${prompt}`,
      session,
      aborted: false,
      steered: false,
    } as any;
  });
}

const request = (agentId: string, prompt = "fix it"): WorkflowSpawnRequest => ({
  agentId,
  index: 0,
  prompt,
  label: agentId,
  agentType: "general-purpose",
});

describe("a settled workflow child keeps its record, not its session (#4)", () => {
  let manager: AgentManager;

  beforeEach(() => {
    registerAgents(new Map());
    sessions = [];
    mockRunAgent();
    manager = new AgentManager();
  });

  afterEach(async () => {
    await manager.dispose();
    vi.mocked(runAgent).mockReset();
    vi.mocked(createWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReset();
  });

  it("shuts the session down when the child settles, and keeps its result, usage and files", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });

    const result = await host.spawnAgent(request("wf-agent-0", "scan the routes"));

    expect(result).toMatchObject({ ok: true, text: "done: scan the routes", tokens: 15, outputTokens: 5 });
    const [session] = sessions;
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
    // Extensions got their shutdown first, so their timers stop with it.
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.listeners.size).toBe(0);

    const record = manager.listAgents()[0];
    expect(record.session).toBeUndefined();
    expect(record).toMatchObject({
      status: "completed",
      result: "done: scan the routes",
      sessionFile: SESSION_FILE,
      lifetimeUsage: { input: 10, output: 5 },
    });
    expect(record.completedAt).toBeGreaterThanOrEqual(record.startedAt);
  });

  it("leaves a top-level agent's session alone", async () => {
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "plain", { description: "plain", isBackground: true });
    await manager.getRecord(id)!.promise;
    await flush();

    expect(manager.getRecord(id)!.session).toBe(sessions[0]);
    expect(sessions[0].dispose).not.toHaveBeenCalled();
  });

  it("resumes a released child by reopening its session file, on the same record", async () => {
    mockRunAgent({ text: (prompt, resumed) => (resumed ? `continued: ${prompt}` : "fixed") });
    const onChildResume = vi.fn();
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1", onChildResume });
    await host.spawnAgent(request("wf-agent-0"));
    const id = manager.listAgents()[0].id;

    const resumed = await host.resumeAgent("wf-agent-0", "here are the findings");

    expect(resumed).toMatchObject({ ok: true, text: "continued: here are the findings" });
    expect(vi.mocked(runAgent).mock.calls[1][2]).toBe("here are the findings");
    expect(vi.mocked(runAgent).mock.calls[1][3]).toMatchObject({ resumeSessionFile: SESSION_FILE, workflow: true });
    // The caller re-attaches its transcript stream to the reopened session.
    expect(onChildResume).toHaveBeenCalledWith(id, sessions[1]);
    const record = manager.getRecord(id)!;
    expect(manager.listAgents()).toHaveLength(1);
    // Usage carries on across the resume, as on a live session.
    expect(record.lifetimeUsage).toMatchObject({ input: 20, output: 10 });
    // ...and the reopened session is released again once the turn settles.
    await vi.waitFor(() => expect(sessions[1].dispose).toHaveBeenCalledOnce());
    expect(record.session).toBeUndefined();
  });

  it("says what is needed when a released child left no session file to reopen", async () => {
    mockRunAgent({ sessionFile: null });
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    await host.spawnAgent(request("wf-agent-0"));

    const resumed = await host.resumeAgent("wf-agent-0", "continue");

    expect(resumed.ok).toBe(false);
    expect(resumed.ok === false && resumed.error).toMatch(/not saved to disk.*persist_session: true.*rememberAgents/s);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("says so when a released child's session file has gone", async () => {
    const missing = join(SESSION_DIR, "removed-with-its-worktree.jsonl");
    mockRunAgent({ sessionFile: missing });
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    await host.spawnAgent(request("wf-agent-0"));

    const resumed = await host.resumeAgent("wf-agent-0", "continue");

    expect(resumed.ok === false && resumed.error).toMatch(/session file is gone/);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("resumes an isolated child in a worktree made from the branch its changes were saved to", async () => {
    const tree = (path: string) => ({ path, branch: "pi-agent-x", baseSha: "base", workPath: path });
    vi.mocked(createWorktree).mockResolvedValueOnce(tree("/wt/first")).mockResolvedValueOnce(tree("/wt/second"));
    vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: true, branch: "pi-agent-x" });
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    await host.spawnAgent({ ...request("wf-agent-0"), isolation: "worktree" });

    await host.resumeAgent("wf-agent-0", "fix what the review found");

    expect(vi.mocked(createWorktree).mock.calls[0][3]).toBeUndefined();
    expect(vi.mocked(createWorktree).mock.calls[1][3]).toBe("pi-agent-x");
    expect(vi.mocked(cleanupWorktree).mock.calls.map(c => c[2].path)).toEqual(["/wt/first", "/wt/second"]);
  });

  it("a stopped run that ends after its resume cleans up only its own worktree", async () => {
    const tree = (path: string) => ({ path, branch: "pi-agent-x", baseSha: "base", workPath: path });
    vi.mocked(createWorktree).mockResolvedValueOnce(tree("/wt/first")).mockResolvedValueOnce(tree("/wt/second"));
    vi.mocked(cleanupWorktree).mockImplementation(async (_pi, _cwd, wt) => ({ hasChanges: true, branch: `saved-${wt.path}` }));
    let endFirst!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, prompt: string, options: any) => {
      const session = childSession();
      sessions.push(session);
      options.onSessionCreated?.(session);
      // The first run ignores its stop until told to end; the resume ends at once.
      if (!options.resumeSessionFile) await new Promise<void>(resolve => { endFirst = resolve; });
      return { responseText: `done: ${prompt}`, session, aborted: false, steered: false } as any;
    });
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    const first = host.spawnAgent({ ...request("wf-agent-0"), isolation: "worktree" });
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    const record = manager.listAgents()[0];
    manager.abort(record.id);
    // Past the stop's grace: settled from outside, so the script can resume it.
    manager.reapStalled(Date.now() + 60_000);
    await first;
    // The stopped run left no saved branch, so the resume starts from HEAD.
    await host.resumeAgent("wf-agent-0", "go on");
    expect(record.worktreeResult).toEqual({ hasChanges: true, branch: "saved-/wt/second" });

    endFirst();
    await vi.waitFor(() => expect(cleanupWorktree).toHaveBeenCalledTimes(2));

    expect(vi.mocked(cleanupWorktree).mock.calls.map(c => c[2].path)).toEqual(["/wt/second", "/wt/first"]);
    // The late ending wrote nothing over the newer invocation's outcome.
    expect(record.worktreeResult).toEqual({ hasChanges: true, branch: "saved-/wt/second" });
  });

  it("releases a child the stall check settles from outside", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: string, options: any) => {
      const session = childSession();
      sessions.push(session);
      options.onSessionCreated?.(session);
      return await new Promise(() => {});
    });
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    const pending = host.spawnAgent(request("wf-agent-0"));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    manager.reapStalled(Date.now() + 2 * manager.getStallLimitMs());

    expect(await pending).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(sessions[0].dispose).toHaveBeenCalledOnce());
    expect(manager.listAgents()[0].session).toBeUndefined();
  });

  it("keeps no session alive across a 200-child run", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    let mostAlive = 0;
    // Ten at a time, as a run's concurrency cap would have them.
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all(Array.from({ length: 10 }, (_, i) => host.spawnAgent(request(`wf-agent-${batch * 10 + i}`))));
      await flush();
      mostAlive = Math.max(mostAlive, sessions.filter(s => !s.disposed).length);
    }

    expect(sessions).toHaveLength(200);
    expect(mostAlive).toBe(0);
    // Every record is still held for the run, and none holds a session.
    expect(manager.listAgents()).toHaveLength(200);
    expect(manager.listAgents().filter(r => r.session !== undefined)).toHaveLength(0);
  });
});

describe("the extension lets go of a settled child, and its run can be stopped", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;
  const handoffMs = workflowHandoff.ms;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true } });
    sessions = [];
    mockRunAgent();
    booted = makePi();
    subagentsExtension(booted.pi);
  });

  afterEach(async () => {
    workflowHandoff.ms = handoffMs;
    await booted.lifecycle.get("session_shutdown")?.({}, ctx({ cwd: hermetic.dir }));
    await flush();
    vi.mocked(runAgent).mockReset();
    hermetic.restore();
  });

  const run = (script: string, extra: Record<string, unknown> = {}) =>
    booted.tools.get("SubagentWorkflow").execute(
      "tc",
      { script: `export const meta = { name: "wf", description: "d" };\n${script}`, ...extra },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );

  it("drops every subscription to a settled child, transcript stream and tool follower included", async () => {
    const result = await run(
      'const out = await parallel([1, 2, 3].map(n => () => agent("item " + n, { label: "item-" + n })));\nreturn out.join(",");\n',
    );
    const runId = /Task ID: (\S+)/.exec(textOf(result))![1];
    await vi.waitFor(() =>
      expect(booted.pi.sendMessage.mock.calls.some((c: any[]) =>
        String(c[0]?.content).includes(runId) && String(c[0]?.content).includes("<status>Done</status>"))).toBe(true),
      { timeout: 10_000 },
    );

    expect(sessions).toHaveLength(3);
    for (const session of sessions) {
      // The extension subscribed (stall watch, `.output` stream, tool follower)...
      expect(session.subscribe.mock.calls.length).toBeGreaterThanOrEqual(2);
      // ...and nothing is left holding the session once the child settled.
      await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
      expect(session.listeners.size).toBe(0);
      // Let go of from our side too, not only cleared by dispose().
      for (const off of session.unsubscribes) expect(off).toHaveBeenCalled();
    }
  });

  it("lets go of a settled child while the run is still going", async () => {
    // The run's own settle drops every follower at the end; a long run needs
    // each one dropped as its child settles.
    let finishSecond!: () => void;
    const secondGate = new Promise<void>(resolve => { finishSecond = resolve; });
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, prompt: string, options: any) => {
      const session = childSession();
      sessions.push(session);
      await new Promise(resolve => setImmediate(resolve));
      options.onSessionCreated?.(session);
      if (prompt === "second") await secondGate;
      return { responseText: `done: ${prompt}`, session, aborted: false, steered: false } as any;
    });
    await run('await agent("first", { label: "first" });\nreturn await agent("second", { label: "second" });\n');
    await vi.waitFor(() => expect(sessions).toHaveLength(2));

    const [first] = sessions;
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
    for (const off of first.unsubscribes) expect(off).toHaveBeenCalled();
    finishSecond();
  });

  it("stops a running run when an agent asks with `stop`", async () => {
    workflowHandoff.ms = 20;
    const started = await run("await new Promise(() => {});\n");
    const runId = /Task ID: (\S+)/.exec(textOf(started))![1];

    const stopped = await booted.tools.get("SubagentWorkflow").execute("tc-stop", { stop: runId }, undefined, undefined, ctx({ cwd: hermetic.dir }));

    expect(textOf(stopped)).toMatch(new RegExp(`Stopping workflow ${runId}`));
    await vi.waitFor(() =>
      expect(booted.pi.sendMessage.mock.calls.some((c: any[]) =>
        String(c[0]?.content).includes(runId) && String(c[0]?.content).includes("<status>Stopped</status>"))).toBe(true),
      { timeout: 10_000 },
    );
    const again = await booted.tools.get("SubagentWorkflow").execute("tc-stop-2", { stop: runId }, undefined, undefined, ctx({ cwd: hermetic.dir }));
    expect(textOf(again)).toMatch(/not running/);
  });

  it("says so for a run id it does not know", async () => {
    const result = await booted.tools.get("SubagentWorkflow").execute("tc-stop", { stop: "wf_nosuchrun" }, undefined, undefined, ctx({ cwd: hermetic.dir }));
    expect(textOf(result)).toMatch(/Workflow not found: wf_nosuchrun/);
  });

  it("stops a running run when the parent reloads", async () => {
    workflowHandoff.ms = 20;
    const started = await run("await new Promise(() => {});\n");
    const runId = /Task ID: (\S+)/.exec(textOf(started))![1];

    // pi's reload emits `session_shutdown` with reason "reload" into the old extension instance.
    await booted.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx({ cwd: hermetic.dir }));

    // The run settles as stopped, and its settled snapshot is published and kept. No
    // notification follows: the parent session it would go to has ended (upstream drops
    // a pending notification with the session's outbox).
    await vi.waitFor(() =>
      expect(booted.pi.events.emit.mock.calls.some((c: any[]) =>
        c[0] === "subagents:workflow" && c[1]?.id === runId && c[1]?.status === "killed")).toBe(true),
      { timeout: 10_000 },
    );
    expect(booted.pi.appendEntry.mock.calls.some((c: any[]) => c[0] === "subagents:workflow-run" && c[1]?.id === runId)).toBe(true);
  });
});

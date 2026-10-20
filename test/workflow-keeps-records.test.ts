// A workflow script may `agent(prompt, { resume })` a child long after it
// finished: fix, then a fresh review that takes ten to twenty minutes, then
// resume the fixer with the findings. The manager's ten-minute record GC used to
// drop that child in between, so the first resume failed instantly and the run
// carried on with the findings unfixed. A live run now holds its children on
// the manager and hands them back when it settles.
//
// Fake timers are installed BEFORE `new AgentManager()`, as in
// agent-manager-gc.test.ts: the constructor starts the cleanup interval, and
// advancing the timers moves Date.now() along with it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx } from "./helpers/boot-extension.js";

const MINUTE = 60_000;
const mockPi = {} as any;

const spawnRequest = (agentId: string): WorkflowSpawnRequest => ({
  agentId,
  index: 0,
  prompt: "fix the failing test",
  label: agentId,
  agentType: "general-purpose",
});

describe("a live workflow run keeps the records it may resume", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers();
    registerAgents(new Map());
    vi.mocked(runAgent).mockImplementation(async () => ({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    }) as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "fixed the findings" } as any);
    manager = new AgentManager();
  });

  afterEach(async () => {
    await manager.dispose();
    vi.useRealTimers();
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  /** Spawn one child through a host and return the manager id it got. */
  async function spawnThrough(host: ReturnType<typeof createWorkflowHost>, agentId: string) {
    const before = new Set(manager.listAgents().map(a => a.id));
    const result = await host.spawnAgent(spawnRequest(agentId));
    expect(result.ok).toBe(true);
    const record = manager.listAgents().find(a => !before.has(a.id));
    expect(record?.status).toBe("completed");
    return record!.id;
  }

  it("survives cleanup past ten minutes while the run lives, and resumes", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    const id = await spawnThrough(host, "wf-agent-0");

    // A long review sits between the fixer finishing and the resume.
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(manager.getRecord(id)).toBeDefined();

    const resumed = await host.resumeAgent("wf-agent-0", "here are the review findings");
    expect(resumed).toMatchObject({ ok: true, text: "fixed the findings" });
    expect(resumeAgent).toHaveBeenCalledTimes(1);

    // Still held after the resume settles: the script may come back again.
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("goes back to the ten-minute rule from the moment the run settles", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    const id = await spawnThrough(host, "wf-agent-0");
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(manager.getRecord(id)).toBeDefined();

    host.release();

    // Counted from the release, not from when the child finished half an hour
    // ago — otherwise the very next sweep would take it.
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(manager.getRecord(id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("leaves a record no run holds under today's ten-minute rule", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    const held = await spawnThrough(host, "wf-agent-0");
    const loose = manager.spawn(mockPi, ctx(), "general-purpose", "plain", { description: "plain", isBackground: true });
    await manager.getRecord(loose)!.promise;

    await vi.advanceTimersByTimeAsync(11 * MINUTE);

    expect(manager.getRecord(loose)).toBeUndefined();
    expect(manager.getRecord(held)).toBeDefined();
  });

  it("releasing one run does not release a record another run still holds", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    const id = await spawnThrough(host, "wf-agent-0");
    expect(manager.hold(id, "other-run")).toBe(true);

    host.release();
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(manager.getRecord(id)).toBeDefined();

    manager.releaseAll("other-run");
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("takes no hold for a child whose startup finishes after the run was released", async () => {
    // A stopped run settles without waiting for a child still creating its
    // worktree; that child's spawn callback fires after `release()`. Simulated by
    // deferring the callback the host passes to the manager.
    const original = manager.spawnAndWait.bind(manager);
    let late: (() => void) | undefined;
    vi.spyOn(manager, "spawnAndWait").mockImplementation((pi, c, type, prompt, options, onSpawned) =>
      original(pi, c, type, prompt, options, id => {
        late = () => onSpawned?.(id);
      }),
    );
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    const id = await spawnThrough(host, "wf-agent-0");

    host.release();
    expect(late).toBeDefined();
    late!();

    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("refuses to hold a record the manager does not know", () => {
    expect(manager.hold("no-such-agent", "wf-1")).toBe(false);
  });
});

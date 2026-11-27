/**
 * workflow-child-release.test.ts — a settled workflow child keeps its record,
 * not its session.
 *
 * A run held every finished child's live AgentSession until the ten-minute
 * sweep: its extension instances and the timers they armed, its tools and its
 * messages, so a fan-out of hundreds kept hundreds of sessions alive at once.
 * A child's session is now shut down as it settles; `resume` reopens its
 * session file, and the inspector and the conversation viewer read it back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createAgentDetailSource } from "../src/ui/workflow-menu.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx } from "./helpers/boot-extension.js";

const mockPi = {} as any;

let dir: string;
/** A real saved conversation: a resume reopens it, and the inspector reads it. */
let sessionFile: string;

/** A child session as `runAgent` leaves it: extensions bound, and a session file. */
function childSession(file: string | undefined) {
  return {
    dispose: vi.fn(),
    messages: [] as unknown[],
    subscribe: vi.fn(() => () => {}),
    sessionManager: { getSessionFile: () => file },
    extensionRunner: {
      hasHandlers: vi.fn((event: string) => event === "session_shutdown"),
      emit: vi.fn(async () => {}),
    },
  };
}
type ChildSession = ReturnType<typeof childSession>;

/** Every session the mocked `runAgent` handed out, in order. */
let sessions: ChildSession[];

function mockRunAgent(opts: { file?: string | null; fail?: boolean } = {}) {
  vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, prompt: string, options: any) => {
    const session = childSession(opts.file === null ? undefined : (opts.file ?? sessionFile));
    sessions.push(session);
    options.onSessionCreated?.(session);
    options.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0 });
    if (opts.fail) throw new Error("provider down");
    const resumed = options.resumeSessionFile !== undefined;
    return { responseText: `${resumed ? "continued" : "done"}: ${prompt}`, session, aborted: false, steered: false } as any;
  });
}

const request = (agentId: string, prompt = "scan the routes"): WorkflowSpawnRequest => ({
  agentId,
  index: 0,
  prompt,
  label: agentId,
  agentType: "general-purpose",
});

describe("a settled workflow child keeps its record, not its session", () => {
  let manager: AgentManager;

  beforeEach(() => {
    registerAgents(new Map());
    dir = mkdtempSync(join(tmpdir(), "pi-child-release-"));
    const saved = SessionManager.create(dir, dir);
    saved.appendMessage({ role: "user", content: "scan the routes", timestamp: 1 });
    sessionFile = saved.getSessionFile()!;
    sessions = [];
    mockRunAgent();
    manager = new AgentManager();
  });

  afterEach(async () => {
    await manager.dispose();
    vi.mocked(runAgent).mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shuts the session down when the child settles, and keeps its result, usage and file", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });

    const result = await host.spawnAgent(request("wf-agent-0"));

    expect(result).toMatchObject({ ok: true, text: "done: scan the routes", tokens: 15, outputTokens: 5 });
    const [session] = sessions;
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
    // Its extensions got their shutdown, so the timers they armed stop with it.
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    const [record] = manager.listAgents();
    expect(record.session).toBeUndefined();
    expect(record).toMatchObject({ status: "completed", result: "done: scan the routes", sessionFile, lifetimeUsage: { input: 10, output: 5 } });
  });

  it("shuts the session down when the child fails, too", async () => {
    mockRunAgent({ fail: true });
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });

    const result = await host.spawnAgent(request("wf-agent-0"));

    expect(result).toMatchObject({ ok: false, error: "provider down" });
    await vi.waitFor(() => expect(sessions[0].dispose).toHaveBeenCalledOnce());
    expect(manager.listAgents()[0].session).toBeUndefined();
  });

  it("leaves a top-level agent's session alone", async () => {
    const id = manager.spawn(mockPi, ctx(), "general-purpose", "plain", { description: "plain", isBackground: true });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.session).toBe(sessions[0]);
    expect(sessions[0].dispose).not.toHaveBeenCalled();
  });

  it("resumes a released child by reopening its session file under the same id", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    await host.spawnAgent(request("wf-agent-0"));
    const id = manager.listAgents()[0].id;

    const resumed = await host.resumeAgent("wf-agent-0", "here are the findings");

    expect(resumed).toMatchObject({ ok: true, text: "continued: here are the findings", tokens: 15 });
    expect(vi.mocked(runAgent).mock.calls[1][2]).toBe("here are the findings");
    expect(vi.mocked(runAgent).mock.calls[1][3]).toMatchObject({ resumeSessionFile: sessionFile, workflow: true });
    expect(manager.listAgents().map(r => r.id)).toEqual([id]);
    // Still the run's, so the reopened session is released again as it settles.
    expect(manager.getRecord(id)).toMatchObject({ workflowId: "wf-1", status: "completed" });
    await vi.waitFor(() => expect(sessions[1].dispose).toHaveBeenCalledOnce());
    expect(manager.getRecord(id)!.session).toBeUndefined();
  });

  it("refuses to resume a released child whose conversation was never saved, saying why", async () => {
    mockRunAgent({ file: null });
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    await host.spawnAgent(request("wf-agent-0"));

    const resumed = await host.resumeAgent("wf-agent-0", "continue");

    expect(resumed).toEqual({ ok: false, error: expect.stringMatching(/cannot be resumed — its conversation was not saved/) });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("feeds the inspector the released child's conversation from its session file", async () => {
    const host = createWorkflowHost({ pi: mockPi, ctx: ctx(), manager, workflowId: "wf-1" });
    await host.spawnAgent(request("wf-agent-0"));
    const [record] = manager.listAgents();
    expect(record.session).toBeUndefined();

    const detail = createAgentDetailSource(id => manager.getRecord(id))(record.id);

    expect(detail).toMatchObject({ prompt: "scan the routes", outcome: "done: scan the routes" });
  });
});

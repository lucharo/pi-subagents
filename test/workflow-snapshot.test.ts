import { describe, expect, it } from "vitest";
import { workflowSnapshot } from "../src/workflow/snapshot.js";
import { createWorkflowTask, updateWorkflowProgressBatch } from "../src/workflow/task.js";

describe("workflowSnapshot (fork)", () => {
  const task = () => {
    const t = createWorkflowTask({
      id: "wf_abcdef123456",
      script: "",
      meta: { name: "canary", description: "two phases", phases: [{ title: "Scout" }, { title: "Fan-out" }] },
      startTime: 1000,
    });
    updateWorkflowProgressBatch(t, [
      { type: "workflow_phase", index: 0, title: "Scout" },
      { type: "workflow_agent", index: 0, label: "scout", phaseIndex: 0, phaseTitle: "Scout", state: "start", queuedAt: 1000, startedAt: 1000, recordId: "rec0" },
      { type: "workflow_agent", index: 0, label: "scout", phaseIndex: 0, phaseTitle: "Scout", state: "done", queuedAt: 1000, startedAt: 1000, lastProgressAt: 4000, durationMs: 3000, tokens: 1200, recordId: "rec0" },
      { type: "workflow_phase", index: 1, title: "Fan-out" },
      { type: "workflow_agent", index: 1, label: "sleep-a", phaseIndex: 1, phaseTitle: "Fan-out", state: "start", queuedAt: 4000, startedAt: 4100, recordId: "rec1" },
      { type: "workflow_agent", index: 2, label: "sleep-b", phaseIndex: 1, phaseTitle: "Fan-out", state: "start", queuedAt: 4000 },
    ]);
    return t;
  };

  it("groups agents by phase and counts each agent once", () => {
    const s = workflowSnapshot(task(), () => undefined, 10_000);
    expect(s).toMatchObject({ name: "canary", description: "two phases", status: "running", agentCount: 3, done: 1, running: 2, elapsedMs: 9000 });
    expect(s.phases.map(p => [p.title, p.done, p.total])).toEqual([["Scout", 1, 1], ["Fan-out", 0, 2]]);
    expect(s.agents.map(a => [a.label, a.phase, a.state])).toEqual([
      ["scout", "Scout", "done"],
      ["sleep-a", "Fan-out", "running"],
      ["sleep-b", "Fan-out", "queued"],
    ]);
    expect(s.agents[0]).toMatchObject({ tokens: 1200, endedAt: 4000, durationMs: 3000 });
  });

  it("takes a running child's live tokens, model and tool calls from the host", () => {
    const s = workflowSnapshot(task(), id => (id === "rec1"
      ? { tokens: 500, model: "gpt 5.4 mini", outputFile: "/tmp/x.output", activity: "bash", tools: [{ id: "t1", name: "bash", command: "sleep 20", startedAt: 4200 }] }
      : undefined), 10_000);
    expect(s.agents[1]).toMatchObject({ tokens: 500, model: "gpt 5.4 mini", outputFile: "/tmp/x.output", activity: "bash" });
    expect(s.agents[1].tools?.[0]).toMatchObject({ name: "bash", command: "sleep 20" });
    expect(s.totalTokens).toBe(1700);
    expect(s.phases[1].tokens).toBe(500);
  });

  it("marks agents still live when the run stopped as interrupted", () => {
    const t = task();
    t.status = "killed";
    t.endTime = 6000;
    const s = workflowSnapshot(t, () => undefined, 10_000);
    expect(s.agents.map(a => a.state)).toEqual(["done", "interrupted", "interrupted"]);
    expect(s.elapsedMs).toBe(5000);
  });
});

describe("agentSummary (fork)", () => {
  it("names the count when every agent finished, and done/total otherwise", async () => {
    const { agentSummary } = await import("../src/workflow/task.js");
    expect(agentSummary(3, 0, 3)).toBe("3 agents");
    expect(agentSummary(1, 0, 1)).toBe("1 agent");
    expect(agentSummary(2, 1, 3)).toBe("2/3 agents done, 1 failed");
  });
});

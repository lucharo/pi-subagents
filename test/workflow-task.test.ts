/**
 * workflow-task.test.ts — the record one run lives in.
 *
 * Most of `task.ts` is covered through the tool and command suites, which drive
 * it the way the extension does. The pause bookkeeping is not: it is a small
 * state machine that spans the record and the run's control surface, and the
 * two ways it can go wrong — flipping the record without telling the runtime,
 * or letting a held run keep counting elapsed time — are both invisible from
 * the outside. So it gets driven directly, against a control stub.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowControl } from "../src/workflow/runtime.js";
import {
  completeWorkflowTask,
  createWorkflowTask,
  failWorkflowTask,
  formatSettledEarly,
  pauseWorkflowTask,
  resumeWorkflowTask,
  stopWorkflowTask,
  updateWorkflowProgressBatch,
  type WorkflowTask,
  workflowStalled,
} from "../src/workflow/task.js";

function stubControl(): WorkflowControl & { pause: ReturnType<typeof vi.fn> } {
  return {
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: vi.fn(() => false),
    skip: vi.fn(() => true),
    retry: vi.fn(() => true),
  } as unknown as WorkflowControl & { pause: ReturnType<typeof vi.fn> };
}

function runningTask(): { task: WorkflowTask; control: ReturnType<typeof stubControl> } {
  const task = createWorkflowTask({ id: "wf_abc123", script: "", startTime: 1_000 });
  const control = stubControl();
  task.control = control;
  return { task, control };
}

describe("pausing a run", () => {
  it("tells the run to hold, not just the record", () => {
    // Flipping the status alone would show a paused run in every surface while
    // it kept starting agents.
    const { task, control } = runningTask();

    expect(pauseWorkflowTask(task, 5_000)).toBe(true);
    expect(control.pause).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("paused");
    expect(task.pausedAt).toBe(5_000);
  });

  it("banks the held time on resume, so elapsed does not count it", () => {
    const { task, control } = runningTask();
    pauseWorkflowTask(task, 5_000);

    expect(resumeWorkflowTask(task, 9_000)).toBe(true);
    expect(control.resume).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("running");
    expect(task.totalPausedMs).toBe(4_000);
    expect(task.pausedAt).toBeUndefined();
  });

  it("accumulates across several pauses", () => {
    const { task } = runningTask();
    pauseWorkflowTask(task, 2_000);
    resumeWorkflowTask(task, 3_000);
    pauseWorkflowTask(task, 4_000);
    resumeWorkflowTask(task, 10_000);

    expect(task.totalPausedMs).toBe(7_000);
  });

  it("refuses when there is no run behind the record", () => {
    // A task whose run has settled keeps its progress but loses its control;
    // pausing it would be a status the runtime never agreed to.
    const task = createWorkflowTask({ id: "wf_abc123", script: "" });
    expect(pauseWorkflowTask(task)).toBe(false);
    expect(task.status).toBe("running");
  });

  it("refuses to pause twice or resume something running", () => {
    const { task, control } = runningTask();
    expect(pauseWorkflowTask(task, 1_000)).toBe(true);
    expect(pauseWorkflowTask(task, 2_000)).toBe(false);
    expect(control.pause).toHaveBeenCalledTimes(1);
    // And the first pause's clock is untouched by the refused second one.
    expect(task.pausedAt).toBe(1_000);

    expect(resumeWorkflowTask(task, 3_000)).toBe(true);
    expect(resumeWorkflowTask(task, 4_000)).toBe(false);
    expect(control.resume).toHaveBeenCalledTimes(1);
  });
});

describe("settling a run", () => {
  const result = {
    status: "completed" as const,
    value: 1,
    meta: { name: "wf", description: "d" },
    progress: [],
    agentCount: 0,
    replayedCount: 0,
  };

  it("drops the control so a finished run cannot be paused", () => {
    const { task } = runningTask();
    completeWorkflowTask(task, result);

    expect(task.control).toBeUndefined();
    expect(pauseWorkflowTask(task)).toBe(false);
  });

  it("banks a pause that was still open when the run finished", () => {
    // A run held at a pause can still settle — its last agents finish and the
    // script returns. That time was spent held, and elapsed has to say so.
    const { task } = runningTask();
    pauseWorkflowTask(task, Date.now() - 3_000);
    completeWorkflowTask(task, result);

    expect(task.pausedAt).toBeUndefined();
    expect(task.totalPausedMs).toBeGreaterThanOrEqual(3_000);
    expect(task.status).toBe("completed");
  });

  it("drops the control when the run never started", () => {
    const { task } = runningTask();
    failWorkflowTask(task, "bad meta");

    expect(task.control).toBeUndefined();
    expect(task.status).toBe("failed");
  });
});

describe("formatSettledEarly", () => {
  const settled = (status: "completed" | "failed", outcome: string, agentCount = 0) => {
    const task = createWorkflowTask({ id: "wf_abc123def456", script: "", meta: { name: "wf", description: "d" } });
    task.agentCount = agentCount;
    if (status === "failed") failWorkflowTask(task, outcome);
    else {
      task.status = "completed";
      task.value = outcome;
      task.endTime = task.startTime;
    }
    return task;
  };

  it("bounds a long result like the notification does, and points at the full one", () => {
    const text = formatSettledEarly(settled("completed", "x".repeat(10_000)), "/runs/wf_abc123def456");
    expect(text.length).toBeLessThan(5_000);
    expect(text).toContain("...(truncated)");
    expect(text).toContain("Full result: /runs/wf_abc123def456/run.json");
  });

  it("recommends resuming with the same args once agent calls have settled", () => {
    const text = formatSettledEarly(settled("failed", "boom", 2));
    expect(text).toMatch(/same `args` and resumeFromRunId: "wf_abc123def456"/);
  });

  it("does not contradict a runtime error that says to rerun without resumeFromRunId", () => {
    const text = formatSettledEarly(
      settled("failed", 'agent() opts.resume: "a" was replayed from the resume journal, not run, so there is no conversation in this run to continue. Re-run without resumeFromRunId.', 2),
    );
    expect(text).toContain("Re-run without resumeFromRunId.");
    expect(text).not.toMatch(/resumeFromRunId: "wf_/);
  });
});

describe("a run that stops responding", () => {
  const HOUR = 60 * 60_000;
  afterEach(() => vi.useRealTimers());
  const agent = (index: number, state: "start" | "done" | "error") =>
    ({ type: "workflow_agent", index, label: `a${index}`, state, queuedAt: 1_000, startedAt: 1_000 }) as const;

  it("is stalled once its log has not moved for the limit and no agent is in flight", () => {
    const { task } = runningTask();
    expect(workflowStalled(task, 1_000 + HOUR - 1, HOUR)).toBe(false);
    expect(workflowStalled(task, 1_000 + HOUR, HOUR)).toBe(true);
  });

  it("is not stalled while an agent is in flight, however quiet", () => {
    const { task } = runningTask();
    vi.setSystemTime(2_000);
    updateWorkflowProgressBatch(task, [agent(0, "done"), agent(1, "start")]);
    expect(workflowStalled(task, 2_000 + 10 * HOUR, HOUR)).toBe(false);
    updateWorkflowProgressBatch(task, [agent(1, "error")]);
    expect(workflowStalled(task, Date.now() + HOUR, HOUR)).toBe(true);
    vi.useRealTimers();
  });

  it("counts from its last progress, and a resume starts the clock again", () => {
    const { task } = runningTask();
    vi.setSystemTime(5_000);
    updateWorkflowProgressBatch(task, [agent(0, "done")]);
    expect(workflowStalled(task, 5_000 + HOUR - 1, HOUR)).toBe(false);
    pauseWorkflowTask(task, 6_000);
    expect(workflowStalled(task, 6_000 + 5 * HOUR, HOUR)).toBe(false);
    resumeWorkflowTask(task, 6_000 + 5 * HOUR);
    expect(workflowStalled(task, 6_000 + 5 * HOUR + HOUR - 1, HOUR)).toBe(false);
    expect(workflowStalled(task, 6_000 + 6 * HOUR, HOUR)).toBe(true);
    vi.useRealTimers();
  });

  it("is never stalled with the check off, or once settled", () => {
    const { task } = runningTask();
    expect(workflowStalled(task, 1_000 + 100 * HOUR, 0)).toBe(false);
    failWorkflowTask(task, "boom");
    expect(workflowStalled(task, 1_000 + 100 * HOUR, HOUR)).toBe(false);
  });

  it("settles as failed with the stall's reason, not as a user stop", () => {
    const { task } = runningTask();
    task.stalled = "Workflow stopped responding: nothing written for 60 min.";
    completeWorkflowTask(task, { status: "killed", error: "Workflow aborted.", meta: { name: "n", description: "d" }, progress: [], agentCount: 0, replayedCount: 0 });
    expect(task.status).toBe("failed");
    expect(task.error).toBe("Workflow stopped responding: nothing written for 60 min.");
  });

  it("a run that ended by itself keeps its own outcome even if the check had fired", () => {
    const { task } = runningTask();
    task.stalled = "Workflow stopped responding: nothing written for 60 min.";
    completeWorkflowTask(task, { status: "completed", value: 1, meta: { name: "n", description: "d" }, progress: [], agentCount: 0, replayedCount: 0 });
    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
  });
});

describe("stopWorkflowTask", () => {
  it("aborts the whole run without an index", () => {
    const { task } = runningTask();
    expect(stopWorkflowTask(task)).toBeUndefined();
    expect(task.abortController.signal.aborted).toBe(true);
  });

  it("skips one agent with an index, and says so when it has already finished", () => {
    const { task, control } = runningTask();
    expect(stopWorkflowTask(task, 6)).toBeUndefined();
    expect(control.skip).toHaveBeenCalledWith(6);
    expect(task.abortController.signal.aborted).toBe(false);
    vi.mocked(control.skip).mockReturnValue(false);
    expect(stopWorkflowTask(task, 7)).toBe("Agent is not running");
  });

  it("stops a paused run too, and refuses a settled one", () => {
    const { task } = runningTask();
    pauseWorkflowTask(task);
    expect(stopWorkflowTask(task)).toBeUndefined();
    const done = runningTask().task;
    failWorkflowTask(done, "boom");
    expect(stopWorkflowTask(done)).toBe("Workflow is not running");
    expect(done.abortController.signal.aborted).toBe(false);
  });
});

/**
 * task.ts — the background record one workflow run lives in.
 *
 * A `SubagentWorkflow` tool call returns a task id immediately and the run continues
 * without it, so the run's state cannot live in the tool call's closure: the
 * inline card, the completion notification and (later) the `/agents → Workflows` dialog
 * all read it after `execute` has returned. This is that record, shaped after
 * Claude Code's `local_workflow` task so the fields line up with what the
 * renderers already expect.
 *
 * The progress log is append-only and collapses by index (see `progress.ts`),
 * so every derived counter here is recomputed from the log rather than
 * incremented as entries arrive — a re-emitted agent entry replaces its
 * predecessor, and adding its tokens on top would double-count them.
 */

import { randomUUID } from "node:crypto";
import { escapeXml } from "../xml.js";
import type { WorkflowJournalEntry } from "./journal.js";
import type { WorkflowMeta } from "./meta.js";
import { collapse, elapsedMs, formatDuration, isLive, stats, type WorkflowEntry, type WorkflowRunStatus } from "./progress.js";
import type { WorkflowControl, WorkflowRunResult } from "./runtime.js";

/** `wf_` + hex, matching Claude Code's `^wf_[a-z0-9-]{6,}$` run ids. */
export function workflowRunId(): string {
  return `wf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface WorkflowTask {
  /** Discriminator, alongside Claude Code's `local_agent` / `local_bash`. */
  type: "local_workflow";
  id: string;
  status: WorkflowRunStatus;
  script: string;
  /** Where the script can be edited and re-run from. */
  scriptPath?: string;
  args?: unknown;
  meta?: WorkflowMeta;
  workflowName?: string;
  /** The `tool_use_id` of the call that started this, when one did. */
  toolCallId?: string;

  /**
   * Pause, skip and retry, once the run is up.
   *
   * Absent before the runtime hands it over and after the run settles — the
   * dialog treats "no control" as "those keys do nothing", which is the same
   * thing it does for a run that has finished.
   */
  control?: WorkflowControl;
  /**
   * Fork addition: called when the status changes outside the progress log (pause, resume), so a snapshot listener
   * hears about it even when no agent emits anything afterwards.
   */
  onChange?: () => void;
  /** When the current pause started, so `totalPausedMs` can be closed out. */
  pausedAt?: number;

  /** Where this run records its own settled calls, for a later resume. */
  journalPath?: string;
  /** A previous run's journal, when this call asked to resume one. */
  replay?: readonly WorkflowJournalEntry[];
  /** The run id this one resumed, for the result line that says so. */
  resumedFrom?: string;
  /** How many agents came back from {@link replay} instead of being spawned. */
  replayedCount: number;

  /** The append-only event log, in emission order. */
  workflowProgress: WorkflowEntry[];
  /** Bumped once per applied batch, so a renderer can tell nothing changed. */
  progressVersion: number;
  agentCount: number;
  /**
   * Agents that have settled successfully, recomputed with the other counters.
   *
   * Cached rather than derived on read because the fleet list asks five times a
   * second: deriving it there would walk the whole append-only log on every
   * tick, which for a thousand-agent run is real work in the render loop.
   */
  doneCount: number;
  totalTokens: number;
  totalToolCalls: number;
  logs: string[];

  abortController: AbortController;
  startTime: number;
  endTime?: number;
  /** Excluded from the elapsed clock the header shows. */
  totalPausedMs: number;
  /**
   * When the progress log last moved (or the run was last resumed), for the
   * stall check: see {@link workflowStalled}.
   */
  lastProgressAt?: number;
  /**
   * Why the stall check stopped this run. Set before its signal is aborted, so
   * {@link completeWorkflowTask} records a failure with this reason rather than
   * the user stop an abort otherwise means.
   */
  stalled?: string;

  /** The script's return value, once the run produced one. */
  value?: unknown;
  error?: string;
}

export function createWorkflowTask(init: {
  id: string;
  script: string;
  scriptPath?: string;
  args?: unknown;
  meta?: WorkflowMeta;
  toolCallId?: string;
  startTime?: number;
  journalPath?: string;
  replay?: readonly WorkflowJournalEntry[];
  resumedFrom?: string;
}): WorkflowTask {
  return {
    type: "local_workflow",
    id: init.id,
    status: "running",
    script: init.script,
    scriptPath: init.scriptPath,
    args: init.args,
    meta: init.meta,
    workflowName: init.meta?.name,
    toolCallId: init.toolCallId,
    journalPath: init.journalPath,
    replay: init.replay,
    resumedFrom: init.resumedFrom,
    replayedCount: 0,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    doneCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    abortController: new AbortController(),
    startTime: init.startTime ?? Date.now(),
    totalPausedMs: 0,
  };
}

/**
 * Apply one batch of progress entries.
 *
 * Batched rather than per-entry because that is how the worker emits them, and
 * because every counter below is an O(log) recompute — doing it once per fan-out
 * frame instead of once per agent is the difference that keeps a 200-agent run
 * cheap to render.
 */
export function updateWorkflowProgressBatch(
  task: WorkflowTask,
  entries: readonly WorkflowEntry[],
): void {
  if (entries.length === 0) return;
  task.workflowProgress.push(...entries);
  task.progressVersion++;
  task.lastProgressAt = Date.now();

  const { agents, logs } = collapse(task.workflowProgress);
  task.logs = logs;
  // `agentCount` is what the runtime has scheduled, which can lead what the log
  // has seen — never let a recompute walk it backwards.
  task.agentCount = Math.max(task.agentCount, agents.length);

  let totalTokens = 0;
  let totalToolCalls = 0;
  let done = 0;
  for (const agent of agents) {
    totalTokens += agent.tokens ?? 0;
    totalToolCalls += agent.toolCalls ?? 0;
    // Counted off the collapsed agents, so a re-emitted row counts once.
    if (agent.state === "done") done++;
  }
  task.totalTokens = totalTokens;
  task.totalToolCalls = totalToolCalls;
  task.doneCount = done;
}

/**
 * Hold the run, and stop its clock.
 *
 * The elapsed figure every surface shows subtracts `totalPausedMs`, so a run
 * left paused overnight does not come back reading as a twelve-hour run.
 */
export function pauseWorkflowTask(task: WorkflowTask, now = Date.now()): boolean {
  if (task.status !== "running" || task.control === undefined) return false;
  task.control.pause();
  task.status = "paused";
  task.pausedAt = now;
  task.onChange?.();
  return true;
}

/** Let it go again, banking however long it was held. */
export function resumeWorkflowTask(task: WorkflowTask, now = Date.now()): boolean {
  if (task.status !== "paused" || task.control === undefined) return false;
  task.control.resume();
  task.status = "running";
  task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, now - (task.pausedAt ?? now));
  task.pausedAt = undefined;
  // A long pause is not silence: the stall clock starts again from here.
  task.lastProgressAt = now;
  task.onChange?.();
  return true;
}

/** Settle a task from the run's own result. */
export function completeWorkflowTask(task: WorkflowTask, result: WorkflowRunResult): void {
  // Banked before the status moves off "paused": a run that finished while held
  // still spent that time held, and the elapsed figure has to say so.
  if (task.pausedAt !== undefined) {
    task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, Date.now() - task.pausedAt);
    task.pausedAt = undefined;
  }
  // Nothing left to control, and holding the handle would let the dialog offer
  // pause on a run that has already stopped.
  task.control = undefined;
  // Stopped by the stall check, not by a person: a failure, with its reason.
  const stalled = task.stalled !== undefined && result.status === "killed";
  task.status = stalled ? "failed" : result.status;
  task.meta ??= result.meta;
  task.workflowName ??= result.meta.name;
  task.agentCount = Math.max(task.agentCount, result.agentCount);
  task.replayedCount = result.replayedCount;
  task.value = result.value;
  task.error = stalled ? task.stalled : result.error;
  task.endTime = Date.now();
}

/**
 * Settle a task that never produced a result — a script rejected before the
 * worker started (bad `meta`, oversized source, non-JSON `args`).
 */
export function failWorkflowTask(task: WorkflowTask, error: string): void {
  task.control = undefined;
  task.pausedAt = undefined;
  task.status = "failed";
  task.error = error;
  task.endTime = Date.now();
}

/**
 * Whether a running workflow has stopped responding: its progress log has not
 * moved for `limitMs` and no agent of it is still in flight.
 *
 * A run with a live agent is never stalled here, however long it is quiet: the
 * log only moves when an agent starts or settles, and each agent has a stall
 * check of its own on the manager, whose verdict lands in this log as a failed
 * row. What is left is a script that is spinning, or waiting on nothing, with
 * no agent to show for it. A paused run is waiting on a person, never stalled.
 */
export function workflowStalled(task: WorkflowTask, now: number, limitMs: number): boolean {
  if (limitMs <= 0 || task.status !== "running") return false;
  if (now - (task.lastProgressAt ?? task.startTime) < limitMs) return false;
  return !collapse(task.workflowProgress).agents.some(isLive);
}

/**
 * Stop a run, or one agent of it, for a caller outside the dialog (the
 * `subagents:rpc:workflow-stop` channel). With no `index` the whole run is
 * aborted and settles as stopped; with one, that agent is skipped: its
 * `agent()` call returns `null` and the run goes on. Returns why nothing was
 * stopped, or undefined when something was.
 */
export function stopWorkflowTask(task: WorkflowTask, index?: number): string | undefined {
  if (task.status !== "running" && task.status !== "paused") return "Workflow is not running";
  if (index === undefined) {
    if (!task.abortController.signal.aborted) task.abortController.abort();
    return undefined;
  }
  if (task.control?.skip(index) !== true) return "Agent is not running";
  return undefined;
}

/** The run's outcome as text, for the notification and the LLM-facing result. */
export function workflowResultText(task: WorkflowTask): string {
  if (task.error !== undefined) return task.error;
  if (task.value === undefined) return "No output.";
  if (typeof task.value === "string") return task.value;
  return JSON.stringify(task.value, null, 2);
}

/**
 * Resolve a `resumeFromRunId` against the runs this session has seen.
 *
 * Same-session only, and deliberately so: the journal lives beside the
 * session's task files, and a run id from another session would silently find
 * nothing to replay — reporting that as "resumed" would be a lie the caller
 * could not see through. An unknown id is an error rather than a cold start,
 * because a caller that asked to resume is expecting not to pay.
 */
export function resolveResumeTarget(
  runId: string | undefined,
  tasks: ReadonlyMap<string, WorkflowTask>,
):
  | undefined
  | { ok: true; runId: string; journalPath: string; scriptPath: string }
  | { ok: false; message: string } {
  const id = runId?.trim();
  if (id === undefined || id === "") return undefined;

  const prior = tasks.get(id);
  if (prior === undefined) {
    const known = [...tasks.keys()];
    return {
      ok: false,
      message:
        `No workflow run "${id}" in this session. ` +
        (known.length > 0
          ? `Runs this session: ${known.join(", ")}.`
          : "Nothing has run yet — call this without `resumeFromRunId`."),
    };
  }
  if (prior.status === "running") {
    return {
      ok: false,
      message: `Workflow "${id}" is still running. Stop it from /agents → Workflows before resuming it.`,
    };
  }
  if (prior.journalPath === undefined) {
    return { ok: false, message: `Workflow "${id}" has no journal to resume from.` };
  }
  return {
    ok: true,
    runId: id,
    journalPath: prior.journalPath,
    // The persisted copy, which is what `scriptPath` holds when the call had
    // no file of its own.
    scriptPath: prior.scriptPath ?? "",
  };
}

/**
 * "3 agents", "2/3 agents done, 1 failed": fork wording. "3/15 agents" read as a cap
 * or an index, and the count was of log lines (see `stats`).
 */
export function agentSummary(done: number, failed: number, total: number): string {
  const noun = total === 1 ? "agent" : "agents";
  if (total > 0 && done === total) return `${total} ${noun}`;
  return `${done}/${total} ${noun} done${failed > 0 ? `, ${failed} failed` : ""}`;
}

/** `<task-notification>`, in the same shape a finished background agent sends. */
export function formatWorkflowNotification(task: WorkflowTask, now = Date.now()): string {
  const totals = stats(task.workflowProgress, task.agentCount);
  const status =
    task.status === "completed" ? "Done"
    : task.status === "killed" ? "Stopped"
    : `Error: ${task.error ?? "unknown"}`;
  const result = workflowResultText(task);
  return [
    `<task-notification>`,
    `<task-id>${task.id}</task-id>`,
    task.toolCallId ? `<tool-use-id>${escapeXml(task.toolCallId)}</tool-use-id>` : null,
    task.scriptPath ? `<script>${escapeXml(task.scriptPath)}</script>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Workflow "${escapeXml(task.workflowName ?? task.id)}" ${task.status} — ${agentSummary(totals.done, totals.failedCount, totals.total)}${
      task.replayedCount > 0 ? `, ${task.replayedCount} replayed from ${escapeXml(task.resumedFrom ?? "an earlier run")}` : ""
    }</summary>`,
    `<result>${escapeXml(result.length > 4000 ? `${result.slice(0, 4000)}\n...(truncated)` : result)}</result>`,
    `<usage><total_tokens>${task.totalTokens}</total_tokens><tool_uses>${task.totalToolCalls}</tool_uses><duration_ms>${elapsedMs(task, now)}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join("\n");
}

/**
 * How long a `SubagentWorkflow` call holds its result before handing the run to the background.
 *
 * The call returns as soon as the first live agent starts, the run settles, or this many milliseconds pass, whichever
 * is first. A script that throws on its first lines (a placeholder in `args`, a typo) therefore fails inside the tool
 * result, where the model fixes it in the same turn, instead of as a notification that lands after it has moved on.
 * An object rather than a constant so tests can shorten it.
 */
export const workflowHandoff = { ms: 2000 };

/** Whether this progress batch shows an agent actually starting, as opposed to queuing or replaying from a journal. */
export function startsLiveAgent(entries: readonly WorkflowEntry[]): boolean {
  return entries.some(entry => entry.type === "workflow_agent" && entry.startedAt !== undefined && !entry.cached);
}

/** The tool result for a run that settled before it was handed to the background: no notification follows it. */
export function formatSettledEarly(task: WorkflowTask, runDir?: string, now = Date.now()): string {
  const name = task.workflowName ?? task.id;
  const took = formatDuration(elapsedMs(task, now));
  // Same bound the notification uses: an inline result must not flood the caller's context either.
  const result = workflowResultText(task);
  const truncated = result.length > 4000;
  const outcome = truncated ? `${result.slice(0, 4000)}\n...(truncated)` : result;
  const head =
    task.status === "completed" ? `Workflow "${name}" completed in ${took}.`
    : task.status === "killed" ? `Workflow "${name}" was stopped after ${took}.`
    : `Workflow "${name}" failed after ${took}. Nothing is running in the background.`;
  const lines = [
    `${head} No notification will follow.`,
    `Task ID: ${task.id}`,
    task.scriptPath ? `Script: ${task.scriptPath}` : undefined,
    task.journalPath ? `Journal: ${task.journalPath}` : undefined,
    task.replayedCount > 0 ? `Replayed ${task.replayedCount} recorded call(s) from ${task.resumedFrom ?? "an earlier run"}.` : undefined,
    "",
    task.status === "failed" ? `Error: ${outcome}` : `Result:\n${outcome}`,
  ];
  if (truncated) lines.push(runDir ? `Full result: ${runDir}/run.json` : "(result truncated)");
  if (task.status === "failed") {
    // The runtime's own "Re-run without resumeFromRunId" (a resume label that was replayed) must not be contradicted.
    const resumable = task.agentCount > 0 && !/without resumeFromRunId/.test(result);
    lines.push(
      "",
      "Fix the script or `args` and call SubagentWorkflow again" +
        (resumable ? `, with the same \`args\` and resumeFromRunId: "${task.id}" to reuse the agent calls that settled.` : "."),
    );
  }
  return lines.filter(line => line !== undefined).join("\n");
}

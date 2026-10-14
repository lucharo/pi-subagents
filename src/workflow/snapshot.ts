/**
 * snapshot.ts — a workflow run as plain JSON, for other extensions to draw.
 *
 * Fork addition (lucharo/pi-subagents, branch `fluide`). The run's state lives
 * in memory on the {@link WorkflowTask}; nothing outside this extension could
 * see a running workflow's phases or agents. This module turns a task into a
 * JSON-safe snapshot that index.ts emits on `pi.events` as `subagents:workflow`
 * (throttled), hands out through the manager registry's `listWorkflows()`, and
 * appends to the session as a `subagents:workflow-run` entry when the run
 * settles, so a finished run stays readable after a reload.
 *
 * Everything here is pure: the caller passes what it knows about each child
 * (live tokens, model, transcript path, tool calls) through `children`.
 */

import { buildPhaseGroups, collapse, displayState, elapsedMs } from "./progress.js";
import type { WorkflowTask } from "./task.js";

/** One tool call a workflow child made, as the snapshot carries it. */
export interface WorkflowToolCall {
  id: string;
  name: string;
  /** The command for `bash`-like tools, else the first string argument. */
  command?: string;
  startedAt: number;
  endedAt?: number;
  error?: boolean;
}

/** What the host side knows about a child that the progress log does not. */
export interface WorkflowChildInfo {
  tokens?: number;
  toolUses?: number;
  model?: string;
  modelId?: string;
  thinking?: string;
  outputFile?: string;
  sessionFile?: string;
  activity?: string;
  tools?: WorkflowToolCall[];
}

export interface WorkflowAgentSnapshot {
  index: number;
  label: string;
  phase?: string;
  state: string;
  agentType?: string;
  model?: string;
  modelId?: string;
  thinking?: string;
  tokens?: number;
  toolCalls?: number;
  queuedAt?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  recordId?: string;
  outputFile?: string;
  sessionFile?: string;
  activity?: string;
  error?: string;
  cached?: boolean;
  attempt?: number;
  promptPreview?: string;
  resultPreview?: string;
  tools?: WorkflowToolCall[];
}

export interface WorkflowPhaseSnapshot {
  title: string;
  status: string;
  done: number;
  failed: number;
  total: number;
  tokens: number;
  durationMs: number;
  agents: number[];
}

export interface WorkflowSnapshot {
  id: string;
  name: string;
  description?: string;
  status: string;
  startTime: number;
  endTime?: number;
  elapsedMs: number;
  scriptPath?: string;
  journalPath?: string;
  toolCallId?: string;
  resumedFrom?: string;
  replayedCount: number;
  /** Distinct agents the script has started (each `agent()` call is one). */
  agentCount: number;
  done: number;
  failed: number;
  running: number;
  totalTokens: number;
  totalToolCalls: number;
  phases: WorkflowPhaseSnapshot[];
  agents: WorkflowAgentSnapshot[];
  logs: string[];
  error?: string;
  /** Agents left out to keep the snapshot small (only past {@link MAX_AGENTS}). */
  agentsOmitted?: number;
}

/** Cap on agent rows per snapshot; a 1000-agent run still reports its totals. */
export const MAX_AGENTS = 300;
const MAX_LOGS = 20;
const MAX_TOOLS = 12;

const cut = (s: string | undefined, n: number) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function workflowSnapshot(
  task: WorkflowTask,
  children: (recordId: string) => WorkflowChildInfo | undefined = () => undefined,
  now = Date.now(),
): WorkflowSnapshot {
  const { agents, logs } = collapse(task.workflowProgress);
  const active = task.status === "running" || task.status === "paused";
  const groups = buildPhaseGroups(task.workflowProgress, task.meta?.phases);
  const phaseOf = new Map<number, string>();
  for (const g of groups) for (const a of g.agents) phaseOf.set(a.index, g.title);
  let done = 0;
  let failed = 0;
  let running = 0;
  let tokens = 0;
  let toolCalls = 0;
  const rows: WorkflowAgentSnapshot[] = agents.map((a) => {
    const child = a.recordId !== undefined ? children(a.recordId) : undefined;
    const state = displayState(a, active);
    if (state === "done") done++;
    else if (state === "failed" || state === "skipped" || state === "blocked" || state === "interrupted") failed++;
    else running++;
    // A running child's tokens come from its record (the log only learns them at settle).
    const t = a.tokens ?? child?.tokens;
    const tc = a.toolCalls ?? child?.toolUses;
    tokens += t ?? 0;
    toolCalls += tc ?? 0;
    const settled = a.state === "done" || a.state === "error";
    const row: WorkflowAgentSnapshot = {
      index: a.index,
      label: a.label,
      state,
      ...(phaseOf.has(a.index) ? { phase: phaseOf.get(a.index) } : {}),
      ...(a.agentType !== undefined ? { agentType: a.agentType } : {}),
      ...((child?.model ?? a.model) !== undefined ? { model: child?.model ?? a.model } : {}),
      ...((child?.modelId ?? a.modelId) !== undefined ? { modelId: child?.modelId ?? a.modelId } : {}),
      ...((a.thinking ?? child?.thinking) !== undefined ? { thinking: a.thinking ?? child?.thinking } : {}),
      ...(t !== undefined ? { tokens: t } : {}),
      ...(tc !== undefined ? { toolCalls: tc } : {}),
      ...(a.queuedAt !== undefined ? { queuedAt: a.queuedAt } : {}),
      ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
      ...(settled && a.lastProgressAt !== undefined ? { endedAt: a.lastProgressAt } : {}),
      ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
      ...(a.recordId !== undefined ? { recordId: a.recordId } : {}),
      ...(child?.outputFile !== undefined ? { outputFile: child.outputFile } : {}),
      ...(child?.sessionFile !== undefined ? { sessionFile: child.sessionFile } : {}),
      ...(!settled && child?.activity !== undefined ? { activity: child.activity } : {}),
      ...(a.error !== undefined ? { error: cut(a.error, 300) } : {}),
      ...(a.cached ? { cached: true } : {}),
      ...(a.attempt !== undefined && a.attempt > 1 ? { attempt: a.attempt } : {}),
      ...(a.promptPreview !== undefined ? { promptPreview: cut(a.promptPreview, 240) } : {}),
      ...(a.resultPreview !== undefined ? { resultPreview: cut(a.resultPreview, 240) } : {}),
      ...(child?.tools?.length ? { tools: child.tools.slice(-MAX_TOOLS) } : {}),
    };
    return row;
  });
  const phases: WorkflowPhaseSnapshot[] = groups.map((g) => {
    let gf = 0;
    for (const a of g.agents) if (a.state === "error") gf++;
    return {
      title: g.title,
      status: g.status,
      done: g.doneCount,
      failed: gf,
      total: g.totalCount,
      tokens: g.agents.reduce((n, a) => n + (a.tokens ?? (a.recordId !== undefined ? children(a.recordId)?.tokens : undefined) ?? 0), 0),
      durationMs: g.durationMs,
      agents: g.agents.map((a) => a.index),
    };
  });
  const omitted = rows.length > MAX_AGENTS ? rows.length - MAX_AGENTS : 0;
  return {
    id: task.id,
    name: task.workflowName ?? task.meta?.name ?? task.id,
    ...(task.meta?.description ? { description: task.meta.description } : {}),
    status: task.status,
    startTime: task.startTime,
    ...(task.endTime !== undefined ? { endTime: task.endTime } : {}),
    elapsedMs: elapsedMs(task, now),
    ...(task.scriptPath !== undefined ? { scriptPath: task.scriptPath } : {}),
    ...(task.journalPath !== undefined ? { journalPath: task.journalPath } : {}),
    ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
    ...(task.resumedFrom !== undefined ? { resumedFrom: task.resumedFrom } : {}),
    replayedCount: task.replayedCount,
    agentCount: Math.max(task.agentCount, rows.length),
    done,
    failed,
    running,
    totalTokens: Math.max(tokens, task.totalTokens),
    totalToolCalls: Math.max(toolCalls, task.totalToolCalls),
    phases,
    agents: omitted ? rows.slice(-MAX_AGENTS) : rows,
    logs: logs.slice(-MAX_LOGS).map((l) => cut(l, 300) ?? ""),
    ...(task.error !== undefined ? { error: cut(task.error, 500) } : {}),
    ...(omitted ? { agentsOmitted: omitted } : {}),
  };
}

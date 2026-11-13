---
name: subagent-workflows
description: "Rules for SubagentWorkflow scripts that keep one sweep to one run. Load before writing, editing, rerunning or resuming a SubagentWorkflow script, or when a run failed or returned something strange."
---

# Subagent workflows

The `SubagentWorkflow` tool description is the API reference: globals, `agent()` options, `pipeline()`, `resumeFromRunId`. This skill is how to use it so a sweep runs once, cheaply, and fails where you can see it.

## Pass the work list as data

- `args` takes real JSON: the array or object itself, inlined in the tool call. Write out the whole list, even at tens of KB.
- The script has no filesystem, so a placeholder, a file path or `"see below"` reaches it as that literal value. When the data is too big to inline, write it into the script file as a `const` and run that file with `scriptPath`.
- Validate `args` in the script's first lines and `throw` with a message naming what was wrong, before any `agent()` call:

```js
const shards = args?.shards;
if (!shards || typeof shards !== "object" || !Object.values(shards).every(Array.isArray)) {
  throw new Error(`args.shards must map shard name -> array of paths, got ${JSON.stringify(args).slice(0, 200)}`);
}
```

A script that throws before its first agent starts fails inside the tool result. Read that result: `failed after …` means nothing is running, so fix the script or `args` in the same turn. `started in the background` means wait for the notification.

## One script per sweep

Keep finders, merge and verify in one script. `pipeline()` sends each item through every stage with no barrier; plain code between stages (flatten, dedup, filter) belongs in the script too, so the merge never passes through your context. Use one barrier (`parallel()`, then code) only where a stage needs every result from the stage before, such as dedup across all findings.

After every `schema` stage, drop the nulls before using the results: `results.filter(Boolean)`. A null is an agent that failed, was skipped, or never answered through the schema.

## Size a run before you start it

- **Every finished agent stays loaded in the parent Pi until the run ends.** One verify-per-item sweep of 543 items
  held 529 finished agents at once: the parent Pi grew to 1.4–2.1 GB at 67–85% CPU, the user could not open the
  conversation, and it fed a whole-machine freeze (12 Nov 2026). Keep one run to about 100 agents; for more items,
  split them over several runs, each passed its slice in `args`.
- **Cap concurrency yourself.** `pipeline()` and `parallel()` start up to the runtime's cap (16) at once. On a shared
  or loaded machine run a stage in batches (`for` over slices of 4 with `parallel()` inside).
- **Reloading Pi does not stop a run.** It went on for hours after `reload_pi`. Stop it from the Workflows view.
- **To finish a run's last few items, start a small new run over just those items**, built from the journal (the
  items with no verdict), rather than resuming: a resume reruns every `agent()` call from the first changed one, so an
  edited stage near the end of a big run is cheap only if nothing before it changed.

## When a run fails or needs changes

1. Read the run's journal before diagnosing it: the `Journal:` path the tool returned (`<run id>.workflow.jsonl`). It records every agent's actual return value. A run's `run.json` (final snapshot and result) is under `<agent dir>/subagents/<session id>/<run id>/`.
2. Edit the script file at that `Script:` path.
3. Relaunch with `scriptPath`, `resumeFromRunId: "<run id>"` and the same `args` (they are not inherited; correct them here if they were the problem). Unchanged leading `agent()` calls return their recorded results at no cost; the first changed call and everything after it run live.

Resume is the one way to reuse finished agents. Keep the sweep in that one edited script: a second script for the remaining half, or journals merged by hand into a new run, loses the replay and pays for the agents twice. If the edit changed an early call, everything after it reruns; put cheap or changed stages after the expensive ones you want to keep. One exception: `agent({ resume: label })` cannot continue an agent that was replayed, so when the error says to rerun without `resumeFromRunId`, do that.

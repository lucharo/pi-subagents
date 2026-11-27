/**
 * Each test file gets its own Pi agent directory.
 *
 * Pi keeps project trust in `<agentDir>/trust.json` and takes a lock on it while it reads. With the default agent dir
 * (~/.pi/agent, or a shared $PI_CODING_AGENT_DIR) every worker of a parallel run contends for the same lock, and a
 * worker whose test fakes timers can wait on it forever, so `vitest run` hangs. A test that needs a particular agent
 * dir still sets PI_CODING_AGENT_DIR itself; this only replaces the shared default before its file runs.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-test-agent-"));

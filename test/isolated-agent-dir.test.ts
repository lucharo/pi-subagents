import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// test/setup/isolated-agent-dir.ts runs before every test file: each file gets a fresh pi agent directory, so no two
// workers contend for the trust.json lock pi takes, and no test touches the user's own ~/.pi/agent.
describe("the test setup's pi agent directory", () => {
  it("is a fresh temp directory, not the user's ~/.pi/agent", () => {
    const dir = process.env.PI_CODING_AGENT_DIR ?? "";
    expect(dir.startsWith(join(tmpdir(), "pi-subagents-test-agent-"))).toBe(true);
    expect(dir).not.toBe(join(homedir(), ".pi", "agent"));
  });
});

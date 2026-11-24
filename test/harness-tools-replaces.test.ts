/**
 * harness-tools-replaces.test.ts — a harness model provider (Claude Code or Codex run as pi's model) switches off the
 * harness's own subagent tools while pi's `Agent` is offered, if a plugin declares the pair on `harness-tools:replaces`.
 * This extension declares it for `Agent` at load and again whenever a provider asks.
 */
import { describe, expect, it, vi } from "vitest";
import subagentsExtension, { AGENT_REPLACES } from "../src/index.js";

function makePi() {
  const bus = new Map<string, ((d: unknown) => void)[]>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: {
      emit: vi.fn((event: string, data: unknown) => {
        for (const f of bus.get(event) ?? []) f(data);
      }),
      on: vi.fn((event: string, handler: (d: unknown) => void) => {
        bus.set(event, [...(bus.get(event) ?? []), handler]);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return pi;
}

const declarations = (pi: any) => pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "harness-tools:replaces").map((c: any[]) => c[1]);

describe("harness-tools:replaces", () => {
  it("declares that Agent replaces Claude Code's Agent (Task before 2.1.69) and Codex's spawn_agent, at load and on every ask", () => {
    const pi = makePi();
    subagentsExtension(pi);
    expect(declarations(pi)).toEqual([
      {
        tool: "Agent",
        by: "pi-subagents",
        replaces: {
          "claude-code": [
            { tools: ["Agent"], versions: ">=2.1.69" },
            { tools: ["Task"], versions: "<2.1.69" },
          ],
          codex: [{ tools: ["spawn_agent"] }],
        },
      },
    ]);
    pi.events.emit("harness-tools:ask", {});
    pi.events.emit("harness-tools:ask", {});
    expect(declarations(pi)).toEqual([AGENT_REPLACES, AGENT_REPLACES, AGENT_REPLACES]);
  });
});

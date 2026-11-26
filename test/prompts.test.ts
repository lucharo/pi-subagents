import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { buildAgentPrompt, hasSkillsCatalog, hideAllSkills, hideSkillsListedIn, removeSkillsCatalog, stripLackedToolLines } from "../src/prompts.js";
import type { AgentConfig, EnvInfo } from "../src/types.js";

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "darwin",
};

const envNoGit: EnvInfo = {
  isGitRepo: false,
  branch: "",
  platform: "linux",
};

// Initialize default agents
beforeEach(() => {
  registerAgents(new Map());
});

function getDefaultConfig(name: string): AgentConfig {
  return getAgentConfig(name)!;
}

describe("buildAgentPrompt", () => {
  it("includes cwd and git info", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("handles non-git repos", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", envNoGit);
    expect(prompt).toContain("Not a git repository");
    expect(prompt).not.toContain("Branch:");
  });

  it("Explore prompt is read-only", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("file search specialist");
  });

  it("Plan prompt is read-only", () => {
    const config = getDefaultConfig("Plan");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("software architect");
  });

  it("general-purpose uses append mode (parent twin)", () => {
    const config = getDefaultConfig("general-purpose");
    const parentPrompt = "You are a parent coding agent with full powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent with full powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("READ-ONLY");
    // Empty systemPrompt means no <agent_instructions> section
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("general-purpose without parent prompt falls back to generic base", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).not.toContain("READ-ONLY");
  });

  it("append mode with parent prompt includes parent + custom instructions", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "You are a parent coding agent with special powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("parent coding agent with special powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode without parent prompt falls back to generic base", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode with empty systemPrompt is a pure parent clone", () => {
    const config: AgentConfig = {
      name: "clone",
      description: "Clone",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "You are a parent coding agent.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("replace mode uses config systemPrompt directly", () => {
    const config: AgentConfig = {
      name: "custom",
      description: "Custom",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a specialized agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("You are a specialized agent.");
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("You are a pi coding agent sub-agent");
  });

  it("replace mode ignores parent prompt", () => {
    const config: AgentConfig = {
      name: "standalone",
      description: "Standalone",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a standalone agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, "SECRET parent prompt content");
    expect(prompt).toContain("You are a standalone agent.");
    expect(prompt).not.toContain("SECRET parent prompt content");
    expect(prompt).not.toContain("<sub_agent_context>");
  });

  it("append mode bridge contains tool reminders", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt.");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("Use the edit tool instead of sed");
    expect(prompt).toContain("Use the grep tool instead of");
  });

  it("append mode without parent prompt still has bridge", () => {
    const config: AgentConfig = {
      name: "no-parent",
      description: "No parent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra stuff.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).toContain("Extra stuff.");
  });

  it("injects memory block in replace mode", () => {
    const config: AgentConfig = {
      name: "mem-agent",
      description: "Memory Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a memory agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = { memoryBlock: "# Agent Memory\nYou have persistent memory at /tmp/mem/" };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("You are a memory agent.");
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("persistent memory");
  });

  it("injects memory block in append mode", () => {
    const config: AgentConfig = {
      name: "mem-append",
      description: "Memory Append",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Custom instructions.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = { memoryBlock: "# Agent Memory\nPersistent memory here." };
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt.", extras);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("Custom instructions.");
  });

  it("injects preloaded skill blocks", () => {
    const config: AgentConfig = {
      name: "skill-agent",
      description: "Skill Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a skill agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = {
      skillBlocks: [
        { name: "api-conventions", content: "Use REST endpoints." },
        { name: "error-handling", content: "Handle errors gracefully." },
      ],
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("Preloaded Skill: api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
    expect(prompt).toContain("Preloaded Skill: error-handling");
    expect(prompt).toContain("Handle errors gracefully.");
  });

  it("injects both memory and skills", () => {
    const config: AgentConfig = {
      name: "full-agent",
      description: "Full Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Full agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = {
      memoryBlock: "# Memory\nRemember this.",
      skillBlocks: [{ name: "skill1", content: "Skill content." }],
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("Preloaded Skill: skill1");
  });

  it("no extras means no extra sections", () => {
    const config: AgentConfig = {
      name: "plain",
      description: "Plain",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Plain agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).not.toContain("Agent Memory");
    expect(prompt).not.toContain("Preloaded Skill");
  });

  describe("active_agent tag", () => {
    it("tag is present at start of prompt in replace mode", () => {
      const config: AgentConfig = {
        name: "my-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "You are a test agent.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env);
      expect(prompt).toMatch(/^<active_agent name="my-agent"\/>/);
    });

    it("tag follows the cacheable inherited prefix in append mode", () => {
      const config: AgentConfig = {
        name: "my-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "Custom instructions.",
        promptMode: "append",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt.");
      // Parent prompt must form the verbatim, cacheable byte prefix.
      expect(prompt.startsWith("Parent prompt.")).toBe(true);
      // The varying tag follows the static <sub_agent_context> bridge.
      const ctxIdx = prompt.indexOf("<sub_agent_context>");
      const tagIdx = prompt.indexOf('<active_agent name="my-agent"/>');
      expect(ctxIdx).toBeGreaterThan(-1);
      expect(tagIdx).toBeGreaterThan(ctxIdx);
    });

    it("tag uses agent name verbatim", () => {
      const config: AgentConfig = {
        name: "Some Agent With Spaces",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "Test.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env);
      expect(prompt).toContain('<active_agent name="Some Agent With Spaces"/>');
    });

    it("tag appears before the env block in both modes", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const config: AgentConfig = {
          name: "test-agent",
          description: "Test",
          builtinToolNames: [],
          extensions: true,
          skills: true,
          systemPrompt: "Test.",
          promptMode,
          inheritContext: false,
          runInBackground: false,
          isolated: false,
        };
        const prompt = buildAgentPrompt(config, "/workspace", env, "Parent.");
        const tagIndex = prompt.indexOf('<active_agent name="test-agent"/>');
        const envIndex = prompt.indexOf("# Environment");
        expect(tagIndex).toBeLessThan(envIndex);
      }
    });
  });

  // #187: the inherited parent prompt names the main checkout as cwd, so a
  // worktree agent needs to be told which of the two paths is really its own.
  describe("worktree isolation block", () => {
    function worktreeConfig(promptMode: "append" | "replace"): AgentConfig {
      return {
        name: "test-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "Custom instructions.",
        promptMode,
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
    }

    it("is absent without a worktree base", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const prompt = buildAgentPrompt(worktreeConfig(promptMode), "/wt/copy", env, "Parent.", {});
        expect(prompt).not.toContain("<worktree_isolation>");
      }
    });

    it("names the parent checkout and follows the env block in both modes", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const prompt = buildAgentPrompt(worktreeConfig(promptMode), "/wt/copy", env, "Parent.", {
          worktreeBase: "/repo",
        });
        expect(prompt).toContain("isolated git worktree copy of /repo");
        expect(prompt).toContain("never in /repo, even if other instructions name that path");
        expect(prompt.indexOf("<worktree_isolation>")).toBeGreaterThan(prompt.indexOf("Working directory: /wt/copy"));
      }
    });

    it("stays out of the cacheable inherited prefix", () => {
      const prompt = buildAgentPrompt(worktreeConfig("append"), "/wt/copy", env, "Parent prompt.", {
        worktreeBase: "/repo",
      });
      expect(prompt.startsWith("Parent prompt.")).toBe(true);
      expect(prompt.indexOf("<worktree_isolation>")).toBeGreaterThan(prompt.indexOf("<sub_agent_context>"));
    });
  });

  describe("workflow child block", () => {
    function childConfig(promptMode: "append" | "replace"): AgentConfig {
      return {
        name: "test-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "Custom instructions.",
        promptMode,
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
    }

    it("is absent for an ordinary subagent, whose output a person reads", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const prompt = buildAgentPrompt(childConfig(promptMode), "/workspace", env, "Parent.", {});
        expect(prompt).not.toContain("<workflow_child>");
      }
    });

    it("tells a workflow child its final message is the return value, in both modes", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const prompt = buildAgentPrompt(childConfig(promptMode), "/workspace", env, "Parent.", {
          workflowChild: true,
        });
        expect(prompt).toContain("<workflow_child>");
        expect(prompt).toContain("Your final message IS the return value");
        expect(prompt).toContain("no preamble");
        expect(prompt.indexOf("<workflow_child>")).toBeGreaterThan(prompt.indexOf("Working directory: /workspace"));
      }
    });

    it("stays out of the cacheable inherited prefix", () => {
      const prompt = buildAgentPrompt(childConfig("append"), "/workspace", env, "Parent prompt.", {
        workflowChild: true,
      });
      expect(prompt.startsWith("Parent prompt.")).toBe(true);
      expect(prompt.indexOf("<workflow_child>")).toBeGreaterThan(prompt.indexOf("<sub_agent_context>"));
    });

    it("composes with worktree isolation rather than displacing it", () => {
      const prompt = buildAgentPrompt(childConfig("append"), "/wt/copy", env, "Parent.", {
        worktreeBase: "/repo",
        workflowChild: true,
      });
      expect(prompt).toContain("<worktree_isolation>");
      expect(prompt.indexOf("<workflow_child>")).toBeGreaterThan(prompt.indexOf("<worktree_isolation>"));
    });
  });
});

describe("hasSkillsCatalog", () => {
  const skill = (name: string) => ({
    name,
    description: `Use for ${name} <work>.`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: {} as never,
    disableModelInvocation: false,
  });

  it("finds the bare catalog the pinned pi's formatSkillsForPrompt appends", () => {
    const catalog = formatSkillsForPrompt([skill("one"), skill("two")]);
    expect(hasSkillsCatalog(`You are pi.${catalog}\nCurrent working directory: /w`)).toBe(true);
  });

  it("finds pi 1.x's <skills> section, which wraps the same formatter output", () => {
    const catalog = formatSkillsForPrompt([skill("one")]).trim();
    expect(hasSkillsCatalog(`pre\n\n<rules>\nx\n</rules>\n\n<skills>\n${catalog}\n</skills>\n\n<cwd>\n/w\n</cwd>`)).toBe(true);
  });

  it("ignores a <skills> block written in project instructions, and an empty prompt", () => {
    expect(hasSkillsCatalog("<project_context>\n<skills>\n- use tdd\n</skills>\n</project_context>")).toBe(false);
    expect(hasSkillsCatalog("")).toBe(false);
    expect(hasSkillsCatalog(undefined)).toBe(false);
  });
});

describe("hideSkillsListedIn", () => {
  const skill = (name: string, filePath = `/skills/${name}/SKILL.md`) => ({
    name,
    description: `Use for ${name}.`,
    filePath,
    baseDir: filePath.replace(/\/SKILL\.md$/, ""),
    sourceInfo: {} as never,
    disableModelInvocation: false,
  });

  it("hides the skills the inherited catalog lists and keeps the child's own visible", () => {
    const parent = `You are pi.${formatSkillsForPrompt([skill("one"), skill("a&b", "/skills/a&b/SKILL.md")])}`;
    const childSkills = [skill("one"), skill("a&b", "/skills/a&b/SKILL.md"), skill("from-ext", "/ext/from-ext/SKILL.md")];
    const out = hideSkillsListedIn(parent)({ skills: childSkills, diagnostics: [] });
    expect(out.skills.map((s) => [s.name, s.disableModelInvocation])).toEqual([
      ["one", true],
      ["a&b", true],
      ["from-ext", false],
    ]);
    // pi renders only the child-only skill, so no entry appears twice
    const rendered = formatSkillsForPrompt(out.skills);
    expect(rendered).toContain("<name>from-ext</name>");
    expect(rendered).not.toContain("<name>one</name>");
    expect(childSkills[0].disableModelInvocation).toBe(false); // the loader's own list is not mutated
  });

  it("ignores a <location> quoted outside pi's catalog, such as an example in AGENTS.md", () => {
    const agentsMd = "<project_context>\nExample: <skill><location>/ext/from-ext/SKILL.md</location></skill>\n</project_context>";
    const parent = `You are pi.\n${agentsMd}${formatSkillsForPrompt([skill("one")])}`;
    const out = hideSkillsListedIn(parent)({ skills: [skill("one"), skill("from-ext", "/ext/from-ext/SKILL.md")], diagnostics: [] });
    expect(out.skills.map((s) => [s.name, s.disableModelInvocation])).toEqual([
      ["one", true],
      ["from-ext", false],
    ]);
  });
});

describe("removeSkillsCatalog", () => {
  const skill = (name: string) => ({
    name,
    description: `Use for ${name}.`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: {} as never,
    disableModelInvocation: false,
  });

  it("drops pi 1.x's whole <skills> section and leaves the sections around it", () => {
    const catalog = formatSkillsForPrompt([skill("one")]).trim();
    const prompt = `pre\n\n<rules>\n- x\n</rules>\n\n<skills>\n${catalog}\n</skills>\n\n<cwd>\n/w\n</cwd>`;
    expect(removeSkillsCatalog(prompt)).toBe("pre\n\n<rules>\n- x\n</rules>\n\n<cwd>\n/w\n</cwd>");
  });

  it("drops the bare catalog pi 0.84 appends, and leaves a <skills> block from AGENTS.md", () => {
    const own = "<project_context>\n<skills>\n- use tdd\n</skills>\n</project_context>";
    const prompt = `You are pi.\n${own}${formatSkillsForPrompt([skill("one")])}\nCurrent working directory: /w`;
    const out = removeSkillsCatalog(prompt);
    expect(out).not.toContain("<available_skills>");
    expect(out).toContain(own);
    expect(out).toContain("Current working directory: /w");
  });
});

describe("hideAllSkills", () => {
  it("keeps every skill loaded and marks each one hidden from the catalog", () => {
    const skills = [{ name: "a", disableModelInvocation: false }, { name: "b", disableModelInvocation: true }];
    const out = hideAllSkills()({ skills, diagnostics: [] });
    expect(out.skills.map((s) => [s.name, s.disableModelInvocation])).toEqual([["a", true], ["b", true]]);
    expect(formatSkillsForPrompt(out.skills as never)).toBe("");
    expect(skills[0].disableModelInvocation).toBe(false);
  });
});

describe("stripLackedToolLines", () => {
  const parentTools = [
    { name: "read", promptGuidelines: [] },
    { name: "bash", promptGuidelines: ["Use bash for shell work"] },
    { name: "plan", promptGuidelines: ["Keep a plan for 3+ steps", "Update the plan as\nsteps move"] },
    { name: "pin_widget", promptGuidelines: ["Pin a widget for long tasks"] },
    { name: "unpin_widget", promptGuidelines: ["Pin a widget for long tasks"] },
    { name: "list_sessions", promptGuidelines: ["Shared by two tools"] },
    { name: "send_message", promptGuidelines: ["Shared by two tools"] },
  ];

  it("pi 1.x: drops tool lines and rule bullets of parent tools the child lacks", () => {
    const prompt = [
      "You are an expert coding assistant.",
      "",
      "<tools>",
      "- read: Read files",
      "- bash: Run commands",
      "- plan: plan: show plans",
      "- pin_widget / unpin_widget: pin widgets",
      "- list_sessions / send_message: message sessions",
      "- mystery: a tool the parent no longer has",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "</tools>",
      "",
      "<rules>",
      "- Use bash for shell work",
      "- Keep a plan for 3+ steps",
      "- Update the plan as",
      "steps move",
      "- Pin a widget for long tasks",
      "- Shared by two tools",
      "- Be concise in your responses",
      "</rules>",
      "",
      "<project_context>",
      "- plan: an AGENTS.md line that only looks like a tool line",
      "</project_context>",
    ].join("\n");
    const out = stripLackedToolLines(prompt, parentTools, ["read", "bash", "send_message"]);
    expect(out).toBe([
      "You are an expert coding assistant.",
      "",
      "<tools>",
      "- read: Read files",
      "- bash: Run commands",
      "- list_sessions / send_message: message sessions",
      "- mystery: a tool the parent no longer has",
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "</tools>",
      "",
      "<rules>",
      "- Use bash for shell work",
      "- Shared by two tools",
      "- Be concise in your responses",
      "</rules>",
      "",
      "<project_context>",
      "- plan: an AGENTS.md line that only looks like a tool line",
      "</project_context>",
    ].join("\n"));
  });

  it("pi 0.84: works on the Available tools and Guidelines lists", () => {
    const prompt = "You are pi.\n\nAvailable tools:\n- read: Read files\n- plan: show plans\n\nIn addition…\n\nGuidelines:\n- Keep a plan for 3+ steps\n- Be concise in your responses\n\nPi documentation";
    expect(stripLackedToolLines(prompt, parentTools, ["read"])).toBe(
      "You are pi.\n\nAvailable tools:\n- read: Read files\n\nIn addition…\n\nGuidelines:\n- Be concise in your responses\n\nPi documentation",
    );
  });

  it("leaves project context alone, even a <tools> block an AGENTS.md writes, in either rendering", () => {
    const own = "<project_context>\n<tools>\n- plan: how we plan here\n</tools>\n<rules>\n- Keep a plan for 3+ steps\n</rules>\n</project_context>";
    const legacy = `You are pi.\n\nAvailable tools:\n- read: Read files\n- plan: show plans\n\nGuidelines:\n- Keep a plan for 3+ steps\n- Be concise in your responses\n\nPi documentation\n\n${own}`;
    expect(stripLackedToolLines(legacy, parentTools, ["read"])).toBe(`You are pi.\n\nAvailable tools:\n- read: Read files\n\nGuidelines:\n- Be concise in your responses\n\nPi documentation\n\n${own}`);
    const tagged = `pre\n\n<tools>\n- read: Read files\n- plan: show plans\n</tools>\n\n${own}`;
    expect(stripLackedToolLines(tagged, parentTools, ["read"])).toBe(`pre\n\n<tools>\n- read: Read files\n</tools>\n\n${own}`);
  });

  it("changes nothing when the child has every parent tool", () => {
    const prompt = "<tools>\n- plan: show plans\n</tools>\n\n<rules>\n- Keep a plan for 3+ steps\n</rules>";
    expect(stripLackedToolLines(prompt, parentTools, parentTools.map((t) => t.name))).toBe(prompt);
  });
});

/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig, EnvInfo } from "./types.js";

/** Extra sections to inject into the system prompt (memory, skills, etc.). */
export interface PromptExtras {
  /** Persistent memory content to inject (first 200 lines of MEMORY.md + instructions). */
  memoryBlock?: string;
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string }[];
  /**
   * Parent directory the worktree copy was created from. Set only for
   * `isolation: "worktree"` spawns — triggers the block that tells the agent
   * to stay in the copy.
   */
  worktreeBase?: string;
  /**
   * Set only for a workflow's own children, and only when they have no
   * `StructuredOutput` tool to answer through.
   *
   * A workflow child's final text is not read by a human — it is the value
   * `agent()` resolves to, and the script interpolates it straight into the
   * next stage's prompt. Without this, children answer the way every other
   * subagent does (a report addressed to a reader), and the padding becomes
   * input tokens for the stage downstream. Claude Code's `Workflow` tool
   * documents this contract to the script-writing model; this is the end of it
   * that makes the documentation true.
   *
   * Deliberately NOT applied to every subagent. In pi an ordinary agent's
   * output IS read by a human — through FleetView, the conversation viewer and
   * `get_subagent_result` — so terse raw data would be the wrong answer there.
   */
  workflowChild?: boolean;
}

/**
 * Whether a prompt carries pi's own skills catalog: the formatter's fixed preamble line followed by
 * `<available_skills>`. Both renderings have it (pi 1.x inside a `<skills>` section, pi 0.84 bare), and a
 * `<skills>` block someone writes in AGENTS.md does not.
 */
const SKILLS_CATALOG = /The following skills provide specialized instructions for specific tasks\.[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>/g;

export function hasSkillsCatalog(prompt: string | undefined): boolean {
  return !!prompt && /The following skills provide specialized instructions for specific tasks\.[\s\S]*?<available_skills>/.test(prompt);
}

const unescapeXml = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * A `skillsOverride` for the child's resource loader that keeps every skill loaded but marks the ones the
 * inherited catalog already lists (by `<location>`) `disableModelInvocation`, so pi renders only the child's
 * own additions. `/skill:name` still expands (the registry is intact), and skills that extensions add while
 * binding go through the same override: one the parent already lists is hidden, one only the child has stays.
 */
export function hideSkillsListedIn(parentSystemPrompt: string) {
  // only entries inside pi's own catalog(s), never a <location> quoted elsewhere (an XML example in AGENTS.md)
  const catalogs = [...parentSystemPrompt.matchAll(SKILLS_CATALOG)].map((m) => m[0]).join("\n");
  const listed = new Set([...catalogs.matchAll(/<location>([^<]*)<\/location>/g)].map((m) => unescapeXml(m[1])));
  return <S extends { filePath: string; disableModelInvocation: boolean }, D>(base: { skills: S[]; diagnostics: D[] }) => ({
    ...base,
    skills: base.skills.map((skill) => (listed.has(skill.filePath) ? { ...skill, disableModelInvocation: true } : skill)),
  });
}

/**
 * The prompt without pi's skills catalog: the whole `<skills>` section when the catalog is all it holds (pi 1.x),
 * else the catalog alone (pi 0.84). Used when a `subagents:child-resources` listener sets `skillsCatalog: false`.
 */
export function removeSkillsCatalog(prompt: string): string {
  const section = /\n*<skills>\s*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>\s*<\/skills>/g;
  return prompt.replace(section, "").replace(SKILLS_CATALOG, "");
}

/**
 * A `skillsOverride` that keeps every skill loaded (so `/skill:name` expands) but marks each one
 * `disableModelInvocation`, so pi renders no catalog for the child.
 */
export function hideAllSkills() {
  return <S extends { disableModelInvocation: boolean }, D>(base: { skills: S[]; diagnostics: D[] }) => ({
    ...base,
    skills: base.skills.map((skill) => ({ ...skill, disableModelInvocation: true })),
  });
}

/** A tool as the parent sees it: its name and the guideline bullets it adds to the prompt's rules. */
export interface PromptToolInfo {
  name: string;
  promptGuidelines?: string[];
}

/**
 * The inherited parent prompt without the lines that describe tools the child does not have.
 *
 * In append mode a child gets the parent's prompt verbatim, including its tool list and the rule bullets each
 * parent tool contributed. This drops, from pi's own preamble only (before any `<project_context>`, in the one
 * rendering it uses: pi 1.x `<tools>`/`<rules>` sections or pi 0.84 "Available tools:"/"Guidelines:"):
 * - a tool line `- name: …` (or `- a / b: …`) when every tool it names is a parent tool the child lacks;
 * - a rule bullet when every parent tool that contributed it (by `promptGuidelines`) is one the child lacks.
 * Lines naming no parent tool, pi's own rules, and anything outside those two lists stay as they are.
 */
export function stripLackedToolLines(prompt: string, parentTools: PromptToolInfo[], childTools: Iterable<string>): string {
  const has = new Set(childTools);
  const parentNames = new Set(parentTools.map((t) => t.name));
  const lacks = (name: string) => parentNames.has(name) && !has.has(name);
  if (![...parentNames].some(lacks)) return prompt;
  const owners = new Map<string, string[]>();
  for (const tool of parentTools) {
    for (const g of tool.promptGuidelines ?? []) {
      const key = g.trim();
      if (key) owners.set(key, [...(owners.get(key) ?? []), tool.name]);
    }
  }
  // Bullets of one list: a chunk starts at "- " at the start of a line; continuation lines stay with it.
  const filterBullets = (body: string, drop: (text: string) => boolean) =>
    body.split(/\n(?=- )/).filter((chunk) => !(chunk.startsWith("- ") && drop(chunk.slice(2)))).join("\n");
  const dropTool = (text: string) => {
    const m = /^([^:\n]+):/.exec(text);
    if (!m) return false;
    const names = m[1].split(" / ").map((n) => n.trim());
    return names.length > 0 && names.every(lacks);
  };
  const dropRule = (text: string) => {
    const by = owners.get(text.trim());
    return !!by && by.every(lacks);
  };
  // Only pi's own preamble, before any project context (AGENTS.md may hold a <tools> block of its own), and only
  // the rendering that preamble uses.
  const ctxAt = prompt.search(/(^|\n)<project_context>/);
  const head = ctxAt === -1 ? prompt : prompt.slice(0, ctxAt);
  const tail = ctxAt === -1 ? "" : prompt.slice(ctxAt);
  const tagged = /(^|\n)<tools>\n/.test(head);
  const lists: Array<[RegExp, (text: string) => boolean]> = tagged
    ? [
        [/((?:^|\n)<tools>\n)([\s\S]*?)(\n<\/tools>)/, dropTool],
        [/((?:^|\n)<rules>\n)([\s\S]*?)(\n<\/rules>)/, dropRule],
      ]
    : [
        [/(\nAvailable tools:\n)([\s\S]*?)(\n\n)/, dropTool],
        [/(\nGuidelines:\n)([\s\S]*?)(\n\n)/, dropRule],
      ];
  let out = head;
  for (const [re, drop] of lists) {
    out = out.replace(re, (_all, open: string, body: string, close: string) => open + filterBullets(body, drop) + close);
  }
  return out + tail;
}

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: env header + config.systemPrompt (full control, no parent identity)
 * - "append" mode: parent system prompt + sub-agent context + env header + config.systemPrompt
 * - "append" with empty systemPrompt: pure parent clone
 *
 * Both modes include an `<active_agent name="${config.name}"/>` tag so downstream
 * extensions (e.g. permission/policy systems) can resolve per-agent policy
 * inside the child session by parsing the system prompt. In replace mode the tag
 * is prepended; in append mode it follows the shared inherited content so the
 * parent prompt forms an identical, cacheable byte prefix with the parent
 * session (the LLM's KV cache can then reuse those tokens across every spawn).
 *
 * @param parentSystemPrompt  The parent agent's effective system prompt (for append mode).
 * @param extras  Optional extra sections to inject (memory, preloaded skills).
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  // A worktree agent is told its cwd twice: by the env block above (the copy)
  // and by whatever names the main checkout — the inherited parent prompt in
  // append mode, or the task prompt in either mode. It follows the latter and
  // works in the shared tree (#187), so resolve the contradiction explicitly.
  const worktreeBlock = extras?.worktreeBase
    ? `\n\n<worktree_isolation>
Your working directory is an isolated git worktree copy of ${extras.worktreeBase}.
Work only inside it — never in ${extras.worktreeBase}, even if other instructions name that path as your working directory.
</worktree_isolation>`
    : "";

  // The script, not a person, reads what this child returns — see
  // `PromptExtras.workflowChild` for why only workflow children get this.
  const workflowBlock = extras?.workflowChild
    ? `\n\n<workflow_child>
Your final message IS the return value of this task. A workflow script captures it and passes it to the next stage; no person reads it.
Return only the answer, in exactly the shape the prompt asks for — no preamble, no summary of what you did, no offer to continue.
</workflow_child>`
    : "";

  // Build optional extras suffix
  const extraSections: string[] = [];
  if (extras?.memoryBlock) {
    extraSections.push(extras.memoryBlock);
  }
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }
  const extrasSuffix = extraSections.length > 0 ? "\n\n" + extraSections.join("\n") : "";

  if (config.promptMode === "append") {
    const identity = parentSystemPrompt || genericBase;

    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

    const customSection = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";

    // Place shared/stable content first so the LLM's KV cache can reuse the
    // inherited prefix across all subagent invocations. The parent prompt is
    // placed verbatim (no wrapper tag) so it forms an identical byte prefix
    // with the parent session, maximising KV cache hits. The <active_agent>
    // tag and env block vary per call and are placed after the cached prefix.
    return identity + "\n\n" + bridge + "\n\n" + activeAgentTag + envBlock + worktreeBlock + workflowBlock + customSection + extrasSuffix;
  }

  // "replace" mode — env header + the config's full system prompt
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return activeAgentTag + replaceHeader + worktreeBlock + workflowBlock + "\n\n" + config.systemPrompt + extrasSuffix;
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;

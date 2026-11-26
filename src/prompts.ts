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
  /**
   * Set only for the built-in general-purpose, and only when it received the
   * nested `Agent` tool. Claude Code's general-purpose prompt closes with this
   * line; without it a delegating agent tends to hand its whole task to one
   * child. An agent that cannot spawn gets nothing to misread.
   */
  delegationGuideline?: boolean;
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
 * In append mode a child inherits the parent's `<tools>` and `<rules>` sections verbatim (see
 * {@link inheritableParentPrompt}), including the rule bullets each parent tool contributed. This drops, from pi's
 * own sections only (the first `<tools>` and `<rules>` before any `<project_context>`):
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
  // Only pi's own sections, before any project context (AGENTS.md may hold a <tools> block of its own). Pi
  // writes its own <tools> and <rules> first, so the first match of each is pi's.
  const ctxAt = prompt.search(/(^|\n)<project_context>/);
  const head = ctxAt === -1 ? prompt : prompt.slice(0, ctxAt);
  const tail = ctxAt === -1 ? "" : prompt.slice(ctxAt);
  const lists: Array<[RegExp, (text: string) => boolean]> = [
    [/((?:^|\n)<tools>\n)([\s\S]*?)(\n<\/tools>)/, dropTool],
    [/((?:^|\n)<rules>\n)([\s\S]*?)(\n<\/rules>)/, dropRule],
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

  // Append mode only: the one agent that gets this, general-purpose, is append.
  const delegationBlock = extras?.delegationGuideline
    ? "\n\nYou are already the dedicated agent for this task. Do the work directly — do not re-delegate your entire assignment to another single subagent."
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
    return identity + "\n\n" + bridge + "\n\n" + activeAgentTag + envBlock + worktreeBlock + workflowBlock + delegationBlock + customSection + extrasSuffix;
  }

  // "replace" mode — env header + the config's full system prompt
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return activeAgentTag + replaceHeader + worktreeBlock + workflowBlock + "\n\n" + config.systemPrompt + extrasSuffix;
}

/**
 * The part of the parent's rendered system prompt that an append-mode child inherits.
 *
 * Pi renders a prompt as the preamble followed by tagged sections in a fixed order:
 * `tools`, `rules`, `docs` (default preamble only), `addendum`, `project_context`,
 * `skills`, `cwd`, then the sections extensions add during a turn. The child session renders its own `skills` (from its `skills:`
 * setting), its own `cwd` and its own extension sections after the inherited text.
 * Inheriting the parent's copies too listed them twice, showed the parent's skills to
 * children configured with `skills: false` or a preload list, and left copies that
 * section-editing extensions in the child cannot reach. It also made the result depend
 * on timing: `getSystemPrompt()` includes the extension sections only while the
 * parent's turn runs.
 *
 * Returns the text before the `skills` section, or before the `cwd` section when there
 * are no skills. A prompt without the `cwd` section (for example, a forced prompt) is
 * returned unchanged.
 *
 * @param rendered  The parent's `ctx.getSystemPrompt()`.
 * @param cwd  The cwd the parent's prompt was rendered with.
 */
export function inheritableParentPrompt(rendered: string, cwd: string): string {
  const cwdAt = rendered.lastIndexOf(cwdSection(cwd));
  if (cwdAt < 0) return rendered;
  const head = rendered.slice(0, cwdAt);
  if (!head.endsWith("\n</skills>")) return head;
  const skillsAt = head.lastIndexOf("\n\n<skills>\n");
  return skillsAt < 0 ? head : head.slice(0, skillsAt);
}

/**
 * The parent's rendered system prompt without its `cwd` section, for a session that
 * renders its own `cwd` after the prompt it is given and adds nothing else.
 *
 * Everything else is kept, including sections after `cwd` (extension sections present
 * while the parent's turn runs). A prompt without the section (for example, a forced
 * prompt) is returned unchanged.
 *
 * @param rendered  The parent's `ctx.getSystemPrompt()`.
 * @param cwd  The cwd the parent's prompt was rendered with.
 */
export function withoutCwdSection(rendered: string, cwd: string): string {
  const section = cwdSection(cwd);
  const at = rendered.lastIndexOf(section);
  return at < 0 ? rendered : rendered.slice(0, at) + rendered.slice(at + section.length);
}

/** The `cwd` section as pi renders it after the preceding section. */
function cwdSection(cwd: string): string {
  return `\n\n<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`;
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;

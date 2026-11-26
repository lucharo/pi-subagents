/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export interface ResolveOptions {
  /** A provider to take on a tie: the parent session's, so a subagent of a
   *  session on one login (e.g. `claude-code@subscription`) stays on it when
   *  another provider serves the same model id. */
  prefer?: string;
  /** Let a Claude model no available provider has by its id run on the same
   *  family's model ("claude-opus-4-7" → claude-code/opus). Only where the
   *  caller says so with substitutionNote, or for an agent file's pin, which
   *  otherwise falls back to the parent's model. */
  family?: boolean;
}

/** The Claude family a model name belongs to ("claude-opus-4-7" → "opus"), or
 *  undefined for a name that is not a Claude model. */
export function claudeFamily(input: string): string | undefined {
  const bare = input.slice(input.indexOf("/") + 1).toLowerCase();
  return /claude[-_.\s]*(opus|sonnet|haiku)/.exec(bare)?.[1];
}

/**
 * Why `model` was taken for `input` when it is not what the input names: a
 * provider the input named has no sign-in here (`anthropic/claude-haiku-4-5`
 * running on `claude-code/claude-haiku-4-5-20251001`), or no available model
 * has that id and another of the same Claude family stands in. Undefined when
 * the input picked the model itself. One line, for the start of a tool result.
 */
export function substitutionNote(
  input: string | undefined,
  model: { provider: string; id: string } | undefined,
): string | undefined {
  if (!input || !model) return undefined;
  const slash = input.indexOf("/");
  const asked = (slash === -1 ? input : input.slice(slash + 1)).toLowerCase().replace(/\./g, "-");
  const id = model.id.toLowerCase().replace(/\./g, "-");
  const namedOther = slash !== -1 && input.slice(0, slash).toLowerCase() !== model.provider.toLowerCase();
  // the same model: the same id, or one with a trailing date stamp the other lacks
  const dated = (a: string, b: string) => a.startsWith(`${b}-`) && /^-\d{8}$/.test(a.slice(b.length));
  const sameModel = id === asked || dated(id, asked) || dated(asked, id);
  const family = claudeFamily(input);
  if (!sameModel && family) {
    return `Note: no model "${input}" is available here, so this ran on ${model.provider}/${model.id}, the same Claude family (${family}).\n\n`;
  }
  if (namedOther) {
    return `Note: "${input.slice(0, slash)}" has no sign-in here, so this ran on ${model.provider}/${model.id}.\n\n`;
  }
  return undefined;
}

export function resolveModel(
  input: string,
  registry: ModelRegistry,
  options: ResolveOptions = {},
): any | string {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models. Normalize separators so cosmetic
  // punctuation differences still match — e.g. "claude-haiku-4.5" and
  // "claude-haiku-4-5" (dot vs dash in the version) resolve to the same model.
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20; // all parts present somewhere
    }

    // A tie goes to the preferred provider (the parent session's).
    const preferred = options.prefer && m.provider === options.prefer && bestMatch?.provider !== options.prefer;
    if (score > bestScore || (score > 0 && score === bestScore && preferred)) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. Provider fallback: a "provider/modelId" query that didn't match under the
  // named provider (exact or fuzzy above) retries against all providers. The
  // named provider is preferred when present; this only kicks in when it isn't,
  // so the same model from another provider beats falling back to "inherit".
  if (slashIdx !== -1) {
    const bare = resolveModel(input.slice(slashIdx + 1), registry, options);
    if (typeof bare !== "string") return bare;
  }

  // 4. Family fallback: a Claude model no available provider has by that id
  // (an Anthropic API id on a machine signed in only through Claude Code,
  // whose list may carry just its aliases) runs on the same family's model
  // where one is available: "claude-opus-4-7" → claude-code/opus. The caller
  // says so with substitutionNote.
  const family = options.family ? claudeFamily(input) : undefined;
  if (family) {
    const same = resolveModel(family, registry, options);
    if (typeof same !== "string") return same;
  }

  // 4. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

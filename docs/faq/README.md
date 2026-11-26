# FAQ: the fluide line of pi-subagents

Questions about this fork's `fluide` branch, the line fluide ships. Upstream has no FAQ, so this file never conflicts
with an upstream sync.

## Do we get nested subagents for free?

**Short answer:** Yes. Since the sync with upstream v0.26.3 (#23, merged as aebda86 on 26 Nov 2026), the built-in
`general-purpose` agent can start subagents of its own, as in Claude Code, and fluide keeps that on. `Explore` and `Plan`
never delegate, and a custom agent opts in with `allowed_subagents`. Nesting goes at most `maxSubagentDepth` levels deep
(default 2), with at most `maxConcurrentNested` nested children running at once (default 10). The three delegation tools
add about 1.7k tokens to a child's first request. Lifecycle events now fire for nested agents (`parentAgentId`) and for
workflow agents (`workflowId`) too, so fluide's Tasks tab filters them down to the session's own subagents.

Sources: README.md, "Nested subagents"; `src/nested-tools.ts` and `src/agent-manager.ts` for the defaults;
thenewcomputer/fluide-plugins#1419 for the size and the filter.

## Should the fork's fixes go back upstream?

**Short answer (proposed, after fluide's launch):** Yes. Each change we upstream is one less conflict at the next sync,
and the v0.26.3 sync had 20 files in conflict. #24 lists the candidates in order, starting with the workflow stall check
and fail-fast results. Upstream's CONTRIBUTING asks for an issue before any non-trivial PR, written in the contributor's
own words, so each one starts as an issue the maintainer files himself. Until then `fluide` takes upstream through merge
commits and is never rewritten, so every commit fluide pins stays reachable.

Sources: #24; upstream's CONTRIBUTING.md; #23.

## Which Pi version does the fluide line need? Do we still run Pi 0.84?

**Short answer:** Pi 1.1.0 or newer, as of #23 (26 Nov 2026): `peerDependencies` asks for `>=1.1.0` of pi-ai,
pi-coding-agent and pi-tui, and `typebox` is a peer too. That is why #21, an edge case of Pi 0.84's rendering, was closed
as not applicable. Check `package.json` again after each upstream sync.

Sources: `package.json` `peerDependencies`; #21; #15.

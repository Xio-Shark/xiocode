# ADR-0001: pi-agent over Reasonix as XioCode base

**Status**: accepted
**Date**: 2026-06-02

## Context

XioCode needs a runtime base for its coding agent. Two mature MIT-licensed candidates were evaluated:

- **pi-agent** (`earendil-works/pi`): TypeScript monorepo with in-process extension API (`registerTool`, `registerCommand`, `ctx.on()`), multi-provider LLM support, and comprehensive agent harness lifecycle management.
- **Reasonix** (`esengine/DeepSeek-Reasonix`): Go single binary with TOML config, MCP plugin system (stdio/HTTP subprocesses), allow/ask/deny permissions, workspace sandbox, and DeepSeek prefix-cache optimization.

XioCode's core differentiator is **self-iteration**: the agent must observe its own tool calls, record full conversation trajectories, inject strategy-derived guidance into the system prompt, and hook turn lifecycle events to trigger evolution pipelines.

## Decision

Use **pi-agent** as the runtime base. Extend via its in-process TypeScript extension API. Patch individual packages when the extension API is insufficient.

## Rationale

Self-iteration requires five capabilities:

| Capability | Reasonix MCP plugin | pi-agent extension |
|-----------|--------------------|--------------------|
| Inject system prompt (TODO enforcement + strategy addendum) | Not possible — MCP has no system prompt mutation | `ctx.on("turn.start")` |
| Observe every tool call + result | Not possible — MCP server only sees calls to itself | `ctx.on("tool_call")` |
| Access full conversation history | Not possible — plugin process cannot read agent memory | Shared process memory |
| Write trajectory at turn end | Not possible — plugin doesn't know when turns end | `ctx.on("turn.complete")` |
| Load strategy report at session start | Partial (MCP resource) | `ctx.on("session.start")` |

Reasonix's MCP plugin model is designed for **providing tools to the agent**, not **observing and modifying agent behavior**. Four of five self-iteration requirements are architecturally infeasible through MCP.

pi-agent's in-process extension API provides all five capabilities natively. The xio-evolve extension can implement the full self-iteration pipeline without modifying agent core.

### Ideas borrowed from Reasonix

- TOML configuration format → implemented in the `xio` wrapper CLI
- allow/ask/deny permission semantics → implemented in the xio-sandbox extension
- Prefix cache awareness → inform provider configuration in pi-ai usage

## Consequences

- **Positive**: xio-evolve is a pure extension, no core modifications needed. pi-ace-tool installs directly. Rich extension ecosystem.
- **Negative**: No single-binary distribution (requires Node.js runtime). No built-in TOML config (wrapper CLI handles this). No native prefix-cache optimization (mitigated by provider configuration).
- **Risk**: pi-agent extension API may not cover all future needs. Mitigation: pragmatic patching policy — modify package source when extension API is insufficient.

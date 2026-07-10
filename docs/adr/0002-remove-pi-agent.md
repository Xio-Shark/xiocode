# ADR 0002: Remove pi-agent, own the runtime

## Status

Accepted (2026-07-10). Supersedes ADR 0001 (pi-agent over Reasonix).

## Context

XioCode originally extended pi-agent in-process. That made the product a thin wrapper: CLI spawned `pi`, wrote `.pi/settings.json`, and extensions depended on `@earendil-works/pi-*` APIs. Product identity, release cadence, and tool/provider behavior were coupled to an external mono.

## Decision

1. Implement a self-owned runtime under `src/runtime` (extension host, builtin tools, fetch-based LLM clients, agent loop, REPL).
2. Remove all `@earendil-works/pi-*` dependencies and any spawn of the `pi` binary.
3. Stop writing `.pi/settings.json`; keep configuration under `~/.xiocode/`.
4. Drop pi-ace-tool / `search_context` rather than re-homing it in this change.
5. Keep xio-evolve and xio-sandbox business logic; only change their registration surface to `XioExtensionAPI`.

## Consequences

- Full control over tool loop, provider adapters, and CLI UX.
- Temporary feature gap: no semantic search until a Xio-native tool is added later.
- REPL is intentionally minimal versus pi-tui; polish is a follow-up.
- Docs and AGENTS identity must describe Xio as self-hosted, not “built on pi-agent”.
- Product north star (self-owned loop under merge-ask): [docs/GOAL.md](../GOAL.md).

# Orchestration quality is judged by private regression cases plus the eval gate

XioCode's orchestration (调度机: the request→result pipeline — context assembly, model routing, tool dispatch, explore fan-out, aggregation) is optimized for task outcome quality, and quality claims are only accepted from two judges: the operator's private regression case library (`xio regress`, human verdict) as the primary judge, and `xio eval compare` as the gate. Subjective feel and external public benchmarks (SWE-bench-style) were considered and rejected — feel cannot resolve ~10% strategy deltas and leads to oscillating changes; public benchmarks optimize someone else's task distribution at a cost a single operator cannot sustain.

## Consequences

- Orchestration-code experiments are blocked until the case library holds 10 real cases (as of 2026-07-16 it holds 0 against 39 recorded runs). Filling the library — via failure-signal-triggered one-key capture with subagent evidence enrichment, verdict always human — precedes any scheduler work.
- An orchestration variant is a git ref, compared through the existing eval path; tunables are promoted into `config.toml` one experiment at a time. No upfront policy DSL. Machine-proposed variants (StrategyLearner / PromptEvolver) stay off the default path until the library has meaningful size.
- This makes the failure-driven self-calibration loop, together with the trustable-autonomy chain (worktree + MergeGate + rollback + run evidence), the product identity — orchestration breadth and TUI breadth are explicitly not (TUI feature surface frozen 2026-07-16; aesthetics/smoothness polish only).

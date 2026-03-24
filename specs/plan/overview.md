# Change Plan — Cycle 016 (Benchmark Extraction Cleanup + Major Version Bump)

**Triggered by**: Requirement evolution — benchmark system extracted to separate project (`plan-benchmark`). Clean up stale references in ideate and bump to major version 3.0.0.

---

## What is changing

Three work items:

1. **WI-140**: Remove work items 132-139 from `plan/work-items.yaml` and their implementation notes from `plan/notes/`. These reference `benchmarks/` files that no longer exist in ideate.

2. **WI-141**: Remove the `benchmarking` domain from `specs/domains/`. Update `domains/index.md` to remove the benchmarking entry.

3. **WI-142**: Bump version from 2.1.0 to 3.0.0 in `plugin.json` and `marketplace.json`. Major version bump reflects the benchmark extraction as a breaking change for anyone who depended on `benchmarks/` being part of ideate.

## What is not changing

- All skills, agents, MCP server, scripts
- All other domains (workflow, artifact-structure, agent-system, project-boundaries)
- Guiding principles and constraints
- Architecture

## Why

The benchmark system was moved to `~/code/plan-benchmark/` as a standalone reusable project. References to `benchmarks/` in ideate's artifact directory are now stale. The major version bump signals that the benchmark system is no longer bundled.

## Expected impact

After this cycle, ideate is clean of benchmark references. The archived cycle 014 review and work items remain in `archive/cycles/014/` as historical record.

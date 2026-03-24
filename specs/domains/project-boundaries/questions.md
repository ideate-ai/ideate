# Questions: Project Boundaries

## Q-9: README.md link to outpost repository is unverified
- **Question**: `README.md:16` links to `https://github.com/dan/outpost`. This URL has not been confirmed as a public, accessible repository. Should it be verified before public release, or replaced with a description of where to obtain outpost if the repository will remain private?
- **Source**: archive/cycles/001/gap-analysis.md IN2, archive/cycles/001/decision-log.md OQ8, archive/cycles/001/summary.md (Findings Requiring User Input)
- **Impact**: Users who want outpost-dependent features (spawn_session, remote dispatch) cannot locate the project; they receive a 404 with no alternative guidance.
- **Status**: open
- **Reexamination trigger**: Before any public release of ideate; user decision required on whether outpost is public.

## Q-10: plugin.json and marketplace.json do not mention brrr
- **Question**: Both manifest files describe ideate as "plan, execute, review, refine" — brrr is not listed despite being ideate's primary differentiator after the outpost split. Should "brrr (autonomous SDLC loop)" be added to the description fields?
- **Source**: archive/cycles/001/gap-analysis.md R2, archive/cycles/001/decision-log.md OQ9
- **Impact**: brrr is undiscoverable via plugin metadata; users evaluating ideate from the marketplace listing cannot see the autonomous loop capability.
- **Status**: open
- **Reexamination trigger**: Before any public release; mechanical fix requiring no design decision.

## Q-11: Remote-worker IDEATE_* env var naming inconsistency has no resolution plan
- **Question**: The remote-worker retains `IDEATE_*` env var names even though it is logically owned by outpost. No work item was created to align these names in a future release. Should a compatibility shim or a migration plan be documented?
- **Source**: archive/cycles/001/decision-log.md D3
- **Impact**: Future outpost users will encounter a naming inconsistency between the session-spawner (OUTPOST_*) and the remote-worker (IDEATE_*); this creates confusion in configuration documentation.
- **Status**: open
- **Reexamination trigger**: When outpost reaches its first public release or when a coordinated env-var rename becomes practical.

## Q-37: README Custom Models section omits CLAUDE_CODE_SUBAGENT_MODEL env var
- **Question**: The research document identifies `CLAUDE_CODE_SUBAGENT_MODEL` as a global override that sets the model for all subagents in a session. The README documents per-tier `ANTHROPIC_DEFAULT_*_MODEL` vars but omits this simpler mechanism. Should it be mentioned for users who want a single model for all agents (e.g., single-model Ollama configurations)?
- **Source**: archive/cycles/013/gap-analysis.md MG1; archive/cycles/013/decision-log.md OQ-12
- **Impact**: Users who want the simplest Ollama configuration must set three separate env vars instead of one. The omission affects discoverability, not functionality.
- **Status**: open
- **Reexamination trigger**: Next documentation pass touching README.md Custom Models section.

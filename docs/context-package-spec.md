# Context Package Specification

## Overview

The context package is a pre-assembled markdown document that the review orchestrator builds once and passes inline to all review agents. It replaces the pattern where each agent independently reads the same architecture, principles, and constraints files.

Consumers of this spec: `ideate:review` Phase 3.6, `ideate:brrr` Phase 6b, `mcp/artifact-server` (082).

---

## Sections

The package is a single markdown document with five sections in this order:

### 1. `## Architecture`

Source: `{project_root}/plan/architecture.yaml`

Assembly rule: If the file is ≤300 lines, include in full. If >300 lines, include only:
- The component map section (headings + subsections that list components)
- The interface contracts section (API surface between modules)
- Omit: narrative introduction, detailed implementation notes, rationale prose

### 2. `## Guiding Principles`

Source: `{project_root}/steering/guiding-principles.yaml`

Assembly rule: Include in full. Principles are short and all relevant — no filtering.

### 3. `## Constraints`

Source: `{project_root}/steering/constraints.yaml`

Assembly rule: Include in full.

### 4. `## Source Code Index`

Source: Built dynamically from the project source tree.

Format: Markdown table with columns: `File | Language | Key Exports`

Assembly steps:
1. Glob source files (exclude: test files, generated files, node_modules, .git, dist, build, __pycache__).
2. For each file, detect language from extension.
3. Grep for export/definition patterns:
   - TypeScript/JavaScript: `export (function|class|interface|type|const|default)`
   - Python: `^(def |class )`
   - Go: `^func [A-Z]`
   - Rust: `^pub (fn|struct|trait|enum)`
   - Shell: `^[a-z_]+\(\)`
4. Limit to first 5 exports per file to keep entries brief.
5. Write one row per file: `| path/to/file.ts | TypeScript | exportedFn, ExportedClass, IInterface |`

Size target: ~2-5 lines per file. Omit files with no detectable exports (config files, pure data files).

### 5. `## Full Document Paths`

Absolute paths to the full source documents, for agents that need deeper detail beyond what the package provides:

```
Full architecture: {absolute_path_to_plan/architecture.yaml}
Full principles: {absolute_path_to_steering/guiding-principles.yaml}
Full constraints: {absolute_path_to_steering/constraints.yaml}
```

---

## Size Targets

| Section | Target Lines |
|---|---|
| Architecture | 50-200 |
| Guiding Principles | 30-100 |
| Constraints | 20-60 |
| Source Code Index | ~3× source file count |
| Full Document Paths | 3-5 |
| **Total** | **~500-800** |

If the total exceeds 1000 lines, apply stricter filtering:
- Architecture: component map only (omit interface contracts)
- Source Code Index: limit to 3 exports per file

---

## Availability Check Pattern

Skills that can optionally use the MCP artifact server (082) for the context package should check at runtime:

```
If MCP tool `ideate_get_context_package` is available:
  package = call ideate_get_context_package({project_root})
Else:
  package = assemble_inline (follow steps above)
```

The MCP server caches the package and invalidates on file change. The inline assembly path is the fallback for environments without the MCP server.

---

## Usage in Agent Prompts

Pass the package as inline text in the agent prompt, not as a file path to read:

```
**Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
{context_package}
```

Agents receiving the package should:
- Use it as the primary source for architecture, principles, and constraints
- Use the "Full Document Paths" section to read the original files only when they need detail beyond what the package provides
- Read source code files directly when investigating specific findings (the source code index provides a navigation aid, not a replacement for reading source)

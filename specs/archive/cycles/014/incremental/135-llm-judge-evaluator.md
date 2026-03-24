# Incremental Review: WI-135 — LLM-as-Judge Evaluator

**Verdict: Fail**

Two critical correctness defects exist in `evaluate.sh`. The CLAUDE_RESPONSE heredoc injection is not safe for arbitrary LLM output, and temporary files are written to `/tmp` without using a process-scoped path, creating a race condition in concurrent runs.

---

## Critical Findings

### C1: Unsafe injection of CLAUDE_RESPONSE into heredoc Python string literal
- **File**: `benchmarks/evaluate.sh:258–276`
- **Issue**: `CLAUDE_RESPONSE` is interpolated directly into a Python triple-quoted string literal (`'''${CLAUDE_RESPONSE}'''`) inside a `<<EOF` heredoc. Because the heredoc delimiter is unquoted (`<<EOF`), the shell performs variable expansion. If the claude response contains `'''` (three consecutive single quotes), the Python string terminates early, producing a syntax error and potentially executing injected content as Python code. Claude output routinely contains markdown code fences using triple backticks, and structured output can contain triple single quotes.
- **Impact**: Any claude response containing `'''` causes the Python script to fail with a syntax error, halting evaluation. In a pathological but realistic case where the LLM output contains `'''` followed by Python-compatible statements, those statements execute in the python3 subprocess.
- **Suggested fix**: Pass the JSON response via a temp file or pipe rather than embedding it in a heredoc string. Concretely:

  ```bash
  TMPFILE="$(mktemp)"
  echo "$CLAUDE_RESPONSE" > "$TMPFILE"
  JUDGE_YAML="$(python3 - "$TMPFILE" <<'EOF'
  import sys, json
  data = json.load(open(sys.argv[1]))
  ...
  EOF
  )"
  rm -f "$TMPFILE"
  ```

  Alternatively, use `--output-format text` or capture the response to a file using `claude -p ... > "$TMPFILE"` and read it from disk.

### C2: Unsafe injection of JUDGE_YAML into heredoc Python triple-quoted string
- **File**: `benchmarks/evaluate.sh:311–344`
- **Issue**: `JUDGE_YAML` is interpolated into a Python triple-quoted double-quote string (`"""${JUDGE_YAML}"""`) inside an unquoted `<<PYEOF` heredoc. YAML produced by the LLM is very likely to contain double-quote characters, and triple double-quotes (`"""`) would terminate the Python string early. This is the same class of defect as C1.
- **Impact**: Any judge YAML output containing `"""` (possible in quoted YAML string values or block scalars) causes the meta-injection step to fail. The evaluation is lost even though valid YAML was produced.
- **Suggested fix**: Pass `JUDGE_YAML` via stdin or a temp file:

  ```bash
  FINAL_YAML="$(echo "$JUDGE_YAML" | python3 - "$CASE_NAME" "$RUBRIC_VERSION" "$TIMESTAMP" <<'PYEOF'
  import sys, yaml
  judge_yaml_text = sys.stdin.read()
  case_name, rubric_version, timestamp = sys.argv[1], sys.argv[2], sys.argv[3]
  ...
  PYEOF
  )"
  ```

---

## Significant Findings

### S1: Hardcoded `/tmp` paths cause silent collision in concurrent runs
- **File**: `benchmarks/evaluate.sh:245,297`
- **Issue**: `evaluate-stderr.txt` and `evaluate-yaml-err.txt` are written to `/tmp` with fixed names. If two evaluations run concurrently (e.g., a benchmark suite running cases in parallel), one process's stderr file is overwritten by another, losing the error context that is only read on failure.
- **Impact**: When a concurrent run fails, the error message printed to stderr may belong to a different case, making the failure untraceable.
- **Suggested fix**: Use `mktemp` to create a process-scoped temp file:

  ```bash
  STDERR_TMP="$(mktemp)"
  trap 'rm -f "$STDERR_TMP"' EXIT
  CLAUDE_RESPONSE="$(claude -p --output-format json "$COMPOSED_PROMPT" 2>"$STDERR_TMP")"
  ```

### S2: `$?` check after command substitution containing pipeline is unreliable
- **File**: `benchmarks/evaluate.sh:163,279`
- **Issue**: The pattern `JUDGE_YAML="$(python3 ...)" ` followed by `if [[ $? -ne 0 ]]` is unreliable. In bash, the exit code of a command substitution assignment is the exit code of the last command in the substitution, but assigning a command substitution to a variable with `VAR="$(cmd)"` always exits 0 when `set -e` is not active (it is not active here — `set -uo pipefail` was used, not `set -euo pipefail`). The `$?` check at line 163 and line 279 will always see 0 because bash sets `$?` to 0 for a successful variable assignment even when the command substitution fails.
- **Impact**: If `python3` exits non-zero (e.g., the JSON extraction at line 158 calls `sys.exit(1)`), the assignment still returns 0, `$?` is 0, and the error check is silently bypassed. Execution continues with an empty or partial `BENCHMARK_OUTPUT` / `JUDGE_YAML`.
- **Suggested fix**: Add `set -e` or check the variable's content, or capture the exit code before the assignment:

  ```bash
  BENCHMARK_OUTPUT="$(python3 - "$RAW_OUTPUT_FILE" <<'EOF'
  ...
  EOF
  )" || { echo "ERROR: failed to extract text from raw-output.json" >&2; exit 1; }
  ```

  Alternatively, change line 15 to `set -euo pipefail`.

---

## Minor Findings

### M1: `set -uo pipefail` omits `-e`
- **File**: `benchmarks/evaluate.sh:15`
- **Issue**: `set -uo pipefail` is used without `-e`. Combined with S2 above, this means command failures inside command substitutions are not caught. Most other scripts in this project and the broader convention for defensive shell scripts use `set -euo pipefail`.
- **Suggested fix**: Change line 15 to `set -euo pipefail`.

### M2: `datetime` and `timezone` imported but unused
- **File**: `benchmarks/evaluate.sh:313`
- **Issue**: `from datetime import datetime, timezone` is in the Python heredoc but neither `datetime` nor `timezone` is referenced anywhere in the block. The timestamp is passed as a shell variable.
- **Suggested fix**: Remove the unused import.

### M3: YAML code fence stripping regex only handles leading fences, not trailing `yaml` label
- **File**: `benchmarks/evaluate.sh:285–293`
- **Issue**: The regex `r'^(\`\`\`yaml\s*|\`\`\`\s*)'` handles a leading fence, and `r'\s*\`\`\`$'` handles a trailing fence, but only on a single-line basis due to no `re.MULTILINE` or `re.DOTALL` flag. The LLM wrapping its response in a fenced block spanning multiple lines (which is the standard format) means the anchors `^` and `$` match line-start and line-end only if `re.MULTILINE` is set — without it, `$` matches end-of-string. The stripping logic therefore works only coincidentally (when the entire output is a single string with the fence at position 0 and the closing at the very end), relying on `str.strip()` before the regexes to remove leading whitespace.
- **Suggested fix**: Explicitly use `re.MULTILINE` or use `str.splitlines()` to strip the first and last lines when they are code fences.

---

## Unmet Acceptance Criteria

None. All stated criteria are implemented (files exist, are executable, flags are handled, prompt contains required sections, YAML validation is present, meta section is populated). The defects above are correctness and robustness problems, not missing feature criteria.

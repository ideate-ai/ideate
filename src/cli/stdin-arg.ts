// plugin/src/cli/stdin-arg.ts — the ONE stdin convention shared by both
// shipped CLI binaries (`ideate-work`, `ideate-record`): a flag value of
// exactly `-` means "read this argument's value from stdin", never the
// literal one-character string `-`.
//
// THE DEFECT THIS CLOSES (finding 01M2MKGS5PRV7WSD0W4ZQYAG4A). The record
// CLI's `append --content -` already read this way. `ideate-work
// update-meta --spec -` looked like it followed the same convention and
// silently did not: `-` was treated as an ordinary string value and WRITTEN
// as the new spec, discarding a 4948-byte body piped on stdin without any
// error, any warning, or any anomaly an optimistic-version check could
// catch — a well-formed, successful update that happened to replace several
// kilobytes with one character.
//
// Every stdin-capable flag on EITHER binary must resolve its raw value
// through `resolveStdinArg` below — the ONLY place `-` is special-cased —
// so a future stdin-capable flag cannot reintroduce the same silent path by
// hand-rolling its own check, and so the two binaries cannot drift on what
// `-` means (P-40 sibling-surface parity). `stdinUsageNote` generates the
// `--help` sentence describing the convention for one flag, so the prose in
// both binaries' USAGE text is produced from the SAME template rather than
// two hand-typed copies that can drift apart (P-52).

/** The literal value that means "read this argument from stdin instead". */
export const STDIN_SENTINEL = '-';

/** True exactly when a raw flag value is the stdin sentinel. */
export function isStdinSentinel(value: string | undefined): boolean {
  return value === STDIN_SENTINEL;
}

/**
 * Resolve one flag's raw value against the stdin convention.
 * - `undefined` (the flag was not passed at all) stays `undefined`.
 * - the literal sentinel `-` reads and returns the WHOLE of `readStdin()`.
 * - anything else (including the empty string) passes through unchanged.
 *
 * This is the ONLY function in either CLI that treats `-` as special —
 * every stdin-capable flag must resolve through it rather than testing
 * `=== '-'` locally, so the convention cannot silently diverge per call site.
 */
export async function resolveStdinArg(
  rawValue: string | undefined,
  readStdin: () => Promise<string>,
): Promise<string | undefined> {
  if (rawValue === undefined) return undefined;
  if (!isStdinSentinel(rawValue)) return rawValue;
  return readStdin();
}

/**
 * Drain a stream to a string. A TTY stdin reads as empty — never hangs
 * waiting for input that will never arrive from an interactive terminal.
 */
export async function readAllStdin(stream: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
  if (stream.isTTY === true) return '';
  let data = '';
  for await (const chunk of stream) {
    data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return data;
}

/**
 * One `--help` sentence describing the stdin convention for a single flag —
 * generated, not hand-typed, so every stdin-capable flag on either binary
 * documents itself in IDENTICAL wording. `noun` names what is being read,
 * e.g. "the spec body", "the prose body", "the note body".
 */
export function stdinUsageNote(flag: string, noun: string): string {
  return `\`${flag} -\` reads ${noun} from stdin`;
}

/**
 * Typed CLI-local error for a request to read MORE THAN ONE flag from stdin
 * in the same invocation — stdin is one stream, so at most one flag may
 * claim it per call. Distinct from the engine's own typed errors
 * (WorkStateModuleError / RecordSchemaError): this is a parse-time refusal,
 * never a write.
 */
export class MultipleStdinRequestsError extends Error {
  constructor(flags: readonly string[]) {
    super(`only one argument may read from stdin per invocation, but both ${flags.join(' and ')} requested it ('-')`);
  }
}

/**
 * Guard against more than one flag in the same call requesting stdin: given
 * the flags a subcommand allows to opt into the convention and the parsed
 * raw values, throw {@link MultipleStdinRequestsError} when two or more of
 * them are the sentinel. Callers should run this BEFORE resolving any of
 * them, so a conflicting request fails loud rather than silently letting
 * the second reader see an already-drained (or divergently re-read) stream.
 */
export function assertAtMostOneStdinRequest(values: ReadonlyMap<string, string>, flags: readonly string[]): void {
  const requested = flags.filter((flag) => isStdinSentinel(values.get(flag)));
  if (requested.length > 1) throw new MultipleStdinRequestsError(requested);
}

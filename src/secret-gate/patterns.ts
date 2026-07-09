// plugin/src/secret-gate/patterns.ts — known-pattern secret registry (WI-272).
//
// Spec: docs/spikes/v3-boundary-contract.md §2 "Capture-time secret-scanning
// gate" + cycle-7 amendment I (C2 / Q-35 — Dan's ratified decision). Every
// record write passes its content through a known-pattern scan before the
// write executes; matched content is masked IN PLACE as
// `[REDACTED:pattern-name]`, preserving all surrounding text.
//
// Reference art: the gitleaks / trufflehog pattern classes. Reference art
// ONLY — the amendment is explicit that they are "not a dependency mandate".
// Every regex here is hand-rolled; this module has zero dependencies (not
// even on the telemetry module — the scanner reports redactions through an
// injected callback, see scan.ts).
//
// The honest limit, restated from the amendment: known shapes only. A novel
// secret can pass this gate — which is exactly why the §4.2
// extraordinary-redaction exception exists as the after-the-fact remedy.
// That procedure is a documented MANUAL one and is deliberately NOT
// automated here: §4.2's own guard says a proposal to automate it is
// store-creep.

/** One entry in the known-pattern registry. */
export interface SecretPattern {
  /** Registry name — becomes the mask text `[REDACTED:<name>]`. */
  readonly name: string;
  /**
   * Global regex locating candidate secrets. Patterns that need surrounding
   * context to be precise (e.g. `aws_secret_access_key = <40 base64 chars>`)
   * capture the non-secret context in groups so `redact` can re-emit it.
   */
  readonly regex: RegExp;
  /**
   * Build the masked replacement for ONE regex match. Must embed `marker`
   * and may re-emit captured non-secret context (e.g. `scheme://user:` and
   * `@` for connection strings) so surrounding text is preserved. It never
   * re-emits the secret itself.
   */
  readonly redact: (
    marker: string,
    match: string,
    groups: readonly (string | undefined)[],
  ) => string;
  /**
   * Optional per-match guard (used by the high-entropy heuristic). When
   * present, a regex match is masked only if this returns true.
   */
  readonly accepts?: (match: string, context: { entropyThreshold: number }) => boolean;
}

/** The in-place mask text for a pattern: `[REDACTED:<pattern-name>]`. */
export function redactionMarker(patternName: string): string {
  return `[REDACTED:${patternName}]`;
}

/** Shannon entropy of a token in bits per character (empirical, base 2). */
export function shannonEntropy(token: string): number {
  if (token.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of token) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// ---------------------------------------------------------------------------
// High-entropy heuristic tuning
// ---------------------------------------------------------------------------
//
// The heuristic masks long random-looking tokens that no shape-specific
// pattern names. It is tuned with three independent guards so the common
// NON-secrets that live in a process record — git SHAs, ULIDs, UUIDs, file
// paths, identifiers — can never trigger it:
//
// 1. Minimum length (ENTROPY_MIN_LENGTH = 32). ULIDs are exactly 26
//    characters — below the floor by construction, at any entropy.
//
// 2. Character-class guard: a candidate must contain at least one lowercase
//    letter, one uppercase letter, AND one digit. Git SHAs and SHA-256
//    digests are single-case hex (git emits lowercase); ULIDs are
//    uppercase-only Crockford base32; kebab/snake/camel identifiers lack
//    digits or a case. Random base64/base64url key material of length >= 32
//    misses one of the three classes with probability well under 0.2%.
//
// 3. Entropy threshold (DEFAULT_ENTROPY_THRESHOLD = 4.3 bits/char). The hex
//    alphabet has 16 symbols, so ANY hex string — even a maximally uniform
//    one, at any length — has empirical Shannon entropy <= log2(16) = 4.0,
//    a hard 0.3-bit margin below the threshold. (Guards 2 and 3 each
//    independently exclude every hex string.) UUIDs (hex + hyphen, 17
//    symbols) cap at log2(17) ~= 4.09 — also below. Random base64 material
//    of 32+ chars has expected empirical entropy ~= 4.6–5.3, comfortably
//    above.
//
// The candidate alphabet [A-Za-z0-9+=_-] deliberately EXCLUDES `/` and `.`
// so file paths and dotted identifiers split into short fragments instead of
// forming one long candidate. Base64 secrets containing `/` are covered by
// the context-anchored patterns (e.g. aws-secret-access-key), and the
// residual gap is part of the stated honest limit.
//
// `entropyThreshold` is tunable via scan options (per the WI-272 spec:
// options may tune the callback and the entropy threshold). Tuning affects
// ONLY this heuristic — the shape-specific patterns above it always run.

/** Minimum candidate length for the high-entropy heuristic. ULIDs (26 chars) sit below it. */
export const ENTROPY_MIN_LENGTH = 32;

/**
 * Default entropy threshold in bits/char. Hex strings (git SHA-1, SHA-256)
 * are mathematically capped at 4.0 and can never reach it.
 */
export const DEFAULT_ENTROPY_THRESHOLD = 4.3;

/** Redaction that replaces the whole match — no context to preserve. */
const wholeMatch: SecretPattern['redact'] = (marker) => marker;

/** Redaction that keeps capture group 1 (leading non-secret context) and masks the rest. */
const keepPrefix: SecretPattern['redact'] = (marker, _match, groups) =>
  `${groups[0] ?? ''}${marker}`;

/**
 * The known-pattern registry, applied IN ORDER by scan.ts. Order matters:
 * PEM blocks go first (their base64 body must be consumed as a single block
 * before any token-level pattern sees it), shape-specific patterns next
 * (most-specific first — e.g. anthropic-api-key before openai-api-key, jwt
 * before bearer-token), and the high-entropy catch-all last so it only sees
 * content no named shape claimed.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    // A PEM private-key block is masked AS A WHOLE — header, base64 body,
    // and footer collapse into a single [REDACTED:pem-private-key] (one
    // redaction, not one per line). Covers RSA / EC / DSA / OPENSSH /
    // ENCRYPTED / PKCS#8 unqualified variants.
    name: 'pem-private-key',
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
    redact: wholeMatch,
  },
  {
    // AWS access key ids: 4-char vendor prefix + 16 uppercase alnum
    // (gitleaks-style prefix set).
    name: 'aws-access-key-id',
    regex: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    redact: wholeMatch,
  },
  {
    // AWS secret access keys are 40 chars of [A-Za-z0-9/+] with no
    // distinguishing prefix, so the match is context-anchored: an
    // aws*/secret* key name followed by an assignment. The key name and
    // separator (group 1) are preserved; only the 40-char value (group 2)
    // is masked. A bare 40-char base64 token without that context is left
    // to the high-entropy heuristic — never matched here — which is what
    // keeps 40-hex git SHAs safe from this pattern.
    name: 'aws-secret-access-key',
    regex:
      /\b((?:aws|secret)[\w.-]{0,40}?["']?\s*[:=]{1,2}\s*["']?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    redact: keepPrefix,
  },
  {
    // GitHub tokens: classic (ghp_/gho_/ghu_/ghs_/ghr_ + 36 alnum) and
    // fine-grained (github_pat_ + 36+ [A-Za-z0-9_]).
    name: 'github-token',
    regex: /\b(?:github_pat_[A-Za-z0-9_]{36,}|gh[pousr]_[A-Za-z0-9]{36,})\b/g,
    redact: wholeMatch,
  },
  {
    // Anthropic API keys. Must run BEFORE openai-api-key: both start
    // with `sk-`.
    name: 'anthropic-api-key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    redact: wholeMatch,
  },
  {
    // OpenAI API keys (legacy sk-... and project sk-proj-...). The
    // lookahead excludes Anthropic's sk-ant- namespace, which the previous
    // pattern owns.
    name: 'openai-api-key',
    regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    redact: wholeMatch,
  },
  {
    // Slack tokens: xoxb (bot), xoxa (app), xoxp (user), xoxr (refresh),
    // xoxs (session).
    name: 'slack-token',
    regex: /\bxox[baprs]-[A-Za-z0-9][A-Za-z0-9-]{8,}[A-Za-z0-9]/g,
    redact: wholeMatch,
  },
  {
    // JWTs: three base64url segments, first starting with eyJ ({"…).
    // Runs BEFORE bearer-token so a JWT in an Authorization header gets
    // the more specific name.
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    redact: wholeMatch,
  },
  {
    // Generic bearer tokens in auth headers. Anchored on the header name so
    // prose like "Bearer of good news" can never trigger it; the header
    // context (group 1) is preserved, the token68 value is masked.
    name: 'bearer-token',
    regex: /((?:proxy-)?authorization["']?\s*[:=]\s*["']?bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    redact: keepPrefix,
  },
  {
    // Connection-string passwords: scheme://user:pass@host. Scheme, user,
    // and host survive; only the password is masked. The password class
    // excludes `[` and `]` so an already-masked
    // `user:[REDACTED:connection-string-password]@` can never re-match
    // (idempotency).
    name: 'connection-string-password',
    regex: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/[\]]+)(@)/g,
    redact: (marker, _match, groups) => `${groups[0] ?? ''}${marker}${groups[2] ?? ''}`,
  },
  {
    // High-entropy catch-all — see the tuning block above. Length is
    // enforced by the regex; character classes and entropy by `accepts`.
    name: 'high-entropy',
    regex: /[A-Za-z0-9+=_-]{32,}/g,
    redact: wholeMatch,
    accepts: (match, { entropyThreshold }) =>
      /[a-z]/.test(match) &&
      /[A-Z]/.test(match) &&
      /[0-9]/.test(match) &&
      shannonEntropy(match) >= entropyThreshold,
  },
];

// plugin/src/secret-gate/scan.test.ts — WI-272 acceptance tests.
//
// Asserts the amendment-I contract (docs/spikes/v3-boundary-contract.md §2):
// per-pattern detection with in-place [REDACTED:pattern-name] masking;
// negatives (git SHAs, ULIDs, prose, file paths, already-masked content,
// code fences) pass through byte-identical; every redaction is reported via
// the injected callback; and the gate admits NO skip — type-level and
// runtime.
//
// All secrets below are fakes: AWS's canonical documentation examples, the
// jwt.io demo token, and hand-typed filler.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ENTROPY_THRESHOLD,
  ENTROPY_MIN_LENGTH,
  SECRET_PATTERNS,
  redactionMarker,
  shannonEntropy,
} from './patterns.js';
import { scanAndMask } from './scan.js';
import type { ScanOptions } from './scan.js';

// ---------------------------------------------------------------------------
// Type-level no-skip pin. ScanOptions is a CLOSED tuning surface: exactly
// { onRedaction, entropyThreshold }. Adding any enable/disable/skip switch
// changes `keyof Required<ScanOptions>` and breaks this assertion under tsc.
// ---------------------------------------------------------------------------
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type _ScanOptionsSurfaceIsClosed = AssertTrue<
  Equal<keyof Required<ScanOptions>, 'onRedaction' | 'entropyThreshold'>
>;

// Realistic FAKE secrets, one per registry pattern.
const FAKES = {
  awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE', // canonical AWS docs example
  awsSecretLine: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  githubClassic: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
  githubFineGrained: 'github_pat_11ABCDEFG0123456789abcdefgHIJKLMNOPQRSTUV',
  anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh-QrStUvAA',
  openaiProject: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  openaiLegacy: 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj',
  slack: 'xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  bearerLine: 'Authorization: Bearer AbCdEf123456-token_value.7890',
  connString: 'postgres://app_user:sup3rS3cretPW@db.internal:5432/prod',
  pem: [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA7c9K1FaKeqPhitzUcW9vBqhUXPNCPLJTPquMWzS3ExAmpleF',
    'aKe0nLyBoDyBoDyLinE2FaKe0nLyBoDyBoDyLinE3FaKe0nLyBoDyBoDyLinE4Qz',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n'),
  // 32 distinct chars -> Shannon entropy exactly log2(32) = 5.0 bits/char.
  highEntropy32: 'qHx7Zk2mWpL9vRt3JnB5cYd8FgS4hAe6',
} as const;

const M = redactionMarker; // shorthand: M('jwt') === '[REDACTED:jwt]'

describe('per-pattern positives (in-place masking, context preserved)', () => {
  it('masks AWS access key ids', () => {
    const { content, redactions } = scanAndMask(`key id ${FAKES.awsAccessKeyId} end`);
    expect(content).toBe(`key id ${M('aws-access-key-id')} end`);
    expect(redactions).toEqual([{ pattern: 'aws-access-key-id', count: 1 }]);
  });

  it('masks AWS secret keys, preserving the assignment context', () => {
    const { content } = scanAndMask(FAKES.awsSecretLine);
    expect(content).toBe(`aws_secret_access_key = ${M('aws-secret-access-key')}`);
  });

  it('masks AWS secret keys in JSON-style quoting', () => {
    const input = '"aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
    const { content } = scanAndMask(input);
    expect(content).toBe(`"aws_secret_access_key": "${M('aws-secret-access-key')}"`);
  });

  it('masks classic and fine-grained GitHub tokens', () => {
    const input = `a ${FAKES.githubClassic} b ${FAKES.githubFineGrained} c`;
    const { content, redactions } = scanAndMask(input);
    expect(content).toBe(`a ${M('github-token')} b ${M('github-token')} c`);
    expect(redactions).toEqual([{ pattern: 'github-token', count: 2 }]);
  });

  it('masks Anthropic keys as anthropic-api-key, never openai-api-key', () => {
    const { content, redactions } = scanAndMask(`ANTHROPIC_API_KEY=${FAKES.anthropic}`);
    expect(content).toBe(`ANTHROPIC_API_KEY=${M('anthropic-api-key')}`);
    expect(redactions.map((r) => r.pattern)).toEqual(['anthropic-api-key']);
  });

  it('masks OpenAI keys (project and legacy shapes)', () => {
    const { content } = scanAndMask(`${FAKES.openaiProject} and ${FAKES.openaiLegacy}`);
    expect(content).toBe(`${M('openai-api-key')} and ${M('openai-api-key')}`);
  });

  it('masks Slack tokens', () => {
    const { content } = scanAndMask(`token=${FAKES.slack};`);
    expect(content).toBe(`token=${M('slack-token')};`);
  });

  it('masks bare JWTs', () => {
    const { content } = scanAndMask(`session ${FAKES.jwt} expired`);
    expect(content).toBe(`session ${M('jwt')} expired`);
  });

  it('masks a JWT in an Authorization header as jwt (more specific than bearer-token)', () => {
    const { content, redactions } = scanAndMask(`Authorization: Bearer ${FAKES.jwt}`);
    expect(content).toBe(`Authorization: Bearer ${M('jwt')}`);
    expect(redactions.map((r) => r.pattern)).toEqual(['jwt']);
  });

  it('masks non-JWT bearer tokens in auth headers, preserving the header name', () => {
    const { content } = scanAndMask(`curl -H "${FAKES.bearerLine}"`);
    expect(content).toBe(`curl -H "Authorization: Bearer ${M('bearer-token')}"`);
  });

  it('does NOT mask prose that merely contains the word Bearer', () => {
    const input = 'The Bearer of good news carried authentication-tokens-explained.md along.';
    expect(scanAndMask(input).content).toBe(input);
  });

  it('masks connection-string passwords, preserving scheme, user, and host', () => {
    const { content } = scanAndMask(`db: ${FAKES.connString}`);
    expect(content).toBe(
      `db: postgres://app_user:${M('connection-string-password')}@db.internal:5432/prod`,
    );
  });

  it('masks a PEM block AS A WHOLE — single redaction, header and footer included', () => {
    const input = `before\n${FAKES.pem}\nafter`;
    const { content, redactions } = scanAndMask(input);
    expect(content).toBe(`before\n${M('pem-private-key')}\nafter`);
    expect(redactions).toEqual([{ pattern: 'pem-private-key', count: 1 }]);
  });

  it('masks unqualified and OPENSSH PEM variants; two blocks count as two', () => {
    const block = (kind: string) =>
      `-----BEGIN ${kind}PRIVATE KEY-----\nAbCd1234\n-----END ${kind}PRIVATE KEY-----`;
    const { content, redactions } = scanAndMask(`${block('')}\n${block('OPENSSH ')}`);
    expect(content).toBe(`${M('pem-private-key')}\n${M('pem-private-key')}`);
    expect(redactions).toEqual([{ pattern: 'pem-private-key', count: 2 }]);
  });
});

describe('negatives — byte-identical passthrough', () => {
  const NEGATIVES: Record<string, string> = {
    'git SHA-1 (40 hex)': 'commit b415a1bd3f0161e0c2936f92e26688b9a36c61f0 fixed it',
    'SHA-256 (64 hex)':
      'digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 matches',
    'maximally uniform hex (entropy exactly at the 4.0 hex cap)':
      'id 0123456789abcdef0123456789abcdef01234567 end',
    ULID: 'work item 01ARZ3NDEKTSV4RRFFQ69G5FAV transitioned to done',
    UUID: 'trace 550e8400-e29b-41d4-a716-446655440000 sampled',
    'ordinary prose':
      'The gate lives inside the same write paths as capture itself — no human in the loop.',
    'file path': 'see /Users/dan/code/ideate/plugin/src/secret-gate/patterns.ts line 40',
    'deep dependency path':
      'plugin/node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0/node_modules/zod/dist/index.js',
    'the [REDACTED:x] string itself': 'value was [REDACTED:x] after the gate ran',
    'markdown code fence with innocuous content': [
      'Example:',
      '```ts',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '```',
    ].join('\n'),
    'sk- inside a hyphenated word': 'the risk-assessment-framework-for-capture-points doc',
  };

  for (const [label, input] of Object.entries(NEGATIVES)) {
    it(`passes through: ${label}`, () => {
      const onRedaction = vi.fn();
      const result = scanAndMask(input, { onRedaction });
      expect(result.content).toBe(input); // same reference — byte-identical
      expect(result.redactions).toEqual([]);
      expect(onRedaction).not.toHaveBeenCalled();
    });
  }
});

describe('idempotency — already-masked content is a fixed point', () => {
  it('rescanning masked multi-secret output changes nothing and fires no callback', () => {
    const input = [
      FAKES.awsSecretLine,
      `token ${FAKES.githubClassic}`,
      FAKES.pem,
      FAKES.connString,
      `Authorization: Bearer ${FAKES.jwt}`,
      `blob ${FAKES.highEntropy32}`,
    ].join('\n');
    const first = scanAndMask(input);
    expect(first.redactions.length).toBeGreaterThan(0);

    const onRedaction = vi.fn();
    const second = scanAndMask(first.content, { onRedaction });
    expect(second.content).toBe(first.content);
    expect(second.redactions).toEqual([]);
    expect(onRedaction).not.toHaveBeenCalled();
  });
});

describe('high-entropy heuristic boundaries', () => {
  it('documents the tuning: 32-char distinct-symbol token has entropy 5.0', () => {
    expect(FAKES.highEntropy32).toHaveLength(ENTROPY_MIN_LENGTH);
    expect(shannonEntropy(FAKES.highEntropy32)).toBeCloseTo(5.0, 10);
    expect(DEFAULT_ENTROPY_THRESHOLD).toBeGreaterThan(4.0); // above the hex cap
  });

  it('masks a 32-char high-entropy mixed-class token', () => {
    const { content } = scanAndMask(`key ${FAKES.highEntropy32} end`);
    expect(content).toBe(`key ${M('high-entropy')} end`);
  });

  it('leaves the same token untouched at 31 chars (below the length floor)', () => {
    const input = `key ${FAKES.highEntropy32.slice(0, 31)} end`;
    expect(scanAndMask(input).content).toBe(input);
  });

  it('leaves a 32-char LOW-entropy mixed-class token untouched', () => {
    const token = 'Aa1Aa1Aa1Aa1Aa1Aa1Aa1Aa1Aa1Aa1Aa'; // 3 symbols, H = log2(3) ~ 1.58
    expect(token).toHaveLength(32);
    expect(shannonEntropy(token)).toBeLessThan(DEFAULT_ENTROPY_THRESHOLD);
    const input = `key ${token} end`;
    expect(scanAndMask(input).content).toBe(input);
  });

  it('class guard: long single-case tokens never trigger, whatever their length', () => {
    // Uppercase hex (no lowercase) and lowercase base36 (no uppercase).
    const upperHex = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    const lowerB36 = 'abcdefghijklmnopqrstuvwxyz0123456789abcd';
    const input = `${upperHex} and ${lowerB36}`;
    expect(scanAndMask(input).content).toBe(input);
  });

  it('entropyThreshold tunes the heuristic in both directions', () => {
    const input = `key ${FAKES.highEntropy32} end`;
    expect(scanAndMask(input, { entropyThreshold: 5.5 }).content).toBe(input);
    expect(scanAndMask(input, { entropyThreshold: 4.0 }).content).toBe(
      `key ${M('high-entropy')} end`,
    );
  });

  it('entropyThreshold tunes ONLY the heuristic — shape patterns still run', () => {
    const { content } = scanAndMask(FAKES.awsAccessKeyId, { entropyThreshold: 1000 });
    expect(content).toBe(M('aws-access-key-id'));
  });

  it('rejects non-finite / non-numeric thresholds', () => {
    expect(() => scanAndMask('x', { entropyThreshold: Number.NaN })).toThrow(RangeError);
    expect(() => scanAndMask('x', { entropyThreshold: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() =>
      scanAndMask('x', { entropyThreshold: 'high' } as unknown as ScanOptions),
    ).toThrow(RangeError);
  });
});

describe('onRedaction callback', () => {
  it('is invoked once per matched pattern with its count, mirroring redactions', () => {
    const input = [
      `a ${FAKES.githubClassic}`,
      `b ${FAKES.githubFineGrained}`,
      `c ${FAKES.slack}`,
    ].join('\n');
    const calls: [string, number][] = [];
    const { redactions } = scanAndMask(input, {
      onRedaction: (pattern, count) => calls.push([pattern, count]),
    });
    expect(calls).toEqual([
      ['github-token', 2],
      ['slack-token', 1],
    ]);
    expect(redactions).toEqual([
      { pattern: 'github-token', count: 2 },
      { pattern: 'slack-token', count: 1 },
    ]);
  });

  it('is never invoked for clean content', () => {
    const onRedaction = vi.fn();
    scanAndMask('nothing to see here', { onRedaction });
    expect(onRedaction).not.toHaveBeenCalled();
  });
});

describe('multi-secret content masks all', () => {
  it('masks every secret in a mixed blob and leaves no original behind', () => {
    const secrets = [
      FAKES.awsAccessKeyId,
      FAKES.githubClassic,
      FAKES.anthropic,
      FAKES.openaiProject,
      FAKES.slack,
      FAKES.jwt,
      FAKES.highEntropy32,
    ];
    const input = `intro\n${FAKES.awsSecretLine}\n${secrets.join('\nline ')}\n${FAKES.pem}\n${FAKES.connString}\noutro`;
    const { content, redactions } = scanAndMask(input);
    for (const secret of secrets) expect(content).not.toContain(secret);
    expect(content).not.toContain('wJalrXUtnFEMI'); // AWS secret value
    expect(content).not.toContain('sup3rS3cretPW'); // connection-string password
    expect(content).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(content).toContain('intro');
    expect(content).toContain('outro');
    // Every redaction reported, in registry order, at least 9 patterns deep.
    expect(redactions.length).toBeGreaterThanOrEqual(9);
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(redactions.map((r) => r.pattern)).toEqual(
      names.filter((n) => redactions.some((r) => r.pattern === n)),
    );
  });
});

describe('no skip parameter — the gate cannot be turned off', () => {
  it('scans with no options, undefined options, and null-ish options alike', () => {
    expect(scanAndMask(FAKES.awsAccessKeyId).content).toBe(M('aws-access-key-id'));
    expect(scanAndMask(FAKES.awsAccessKeyId, undefined).content).toBe(M('aws-access-key-id'));
    expect(
      scanAndMask(FAKES.awsAccessKeyId, null as unknown as ScanOptions).content,
    ).toBe(M('aws-access-key-id'));
  });

  it('ignores hostile falsy enable/disable/skip properties — scanning still runs', () => {
    const hostile = {
      enabled: false,
      enable: false,
      disabled: true,
      disable: true,
      skip: true,
      scan: false,
      dryRun: true,
      off: true,
    } as unknown as ScanOptions;
    const { content, redactions } = scanAndMask(FAKES.awsAccessKeyId, hostile);
    expect(content).toBe(M('aws-access-key-id'));
    expect(redactions).toEqual([{ pattern: 'aws-access-key-id', count: 1 }]);
  });

  it('ScanOptions runtime shape carries no switch (type-level pin above)', () => {
    // The type-level assertion _ScanOptionsSurfaceIsClosed pins the option
    // surface to exactly { onRedaction, entropyThreshold } under tsc. At
    // runtime, verify the documented options work and nothing else is read:
    const onRedaction = vi.fn();
    const result = scanAndMask(FAKES.slack, { onRedaction, entropyThreshold: 4.3 });
    expect(result.content).toBe(M('slack-token'));
    expect(onRedaction).toHaveBeenCalledWith('slack-token', 1);
  });
});

describe('registry integrity', () => {
  it('covers all pattern classes the amendment names', () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(names).toEqual([
      'pem-private-key',
      'aws-access-key-id',
      'aws-secret-access-key',
      'github-token',
      'anthropic-api-key',
      'openai-api-key',
      'slack-token',
      'jwt',
      'bearer-token',
      'connection-string-password',
      'high-entropy',
    ]);
  });

  it('every regex is global (required for mask-all replace semantics)', () => {
    for (const p of SECRET_PATTERNS) expect(p.regex.global).toBe(true);
  });

  it('every marker name is shorter than the entropy length floor (idempotency guard)', () => {
    for (const p of SECRET_PATTERNS) expect(p.name.length).toBeLessThan(ENTROPY_MIN_LENGTH);
  });
});

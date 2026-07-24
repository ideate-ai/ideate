// plugin/src/usage/schema.test.ts — tests for the usage signal schema:
// NDJSON round-trip identity, required-field enforcement, deterministic key
// order, and rejection of empty ids.

import { describe, expect, it } from 'vitest';

import {
  UsageSchemaError,
  parseUsageSignal,
  serializeUsageSignal,
  validateUsageSignal,
} from './schema.js';
import type { UsageSignal } from './schema.js';

const full: UsageSignal = {
  id: '01KXKEGNSAK4MCZA3GER8NNS21',
  kind: 'used_context',
  item_id: 'T-381',
  seed_id: 'T-378',
  manifest_id: 'MF-001',
  source: {
    capture_point: 'eval-replay',
    session_id: 'sess-1',
    task_id: 'T-378',
    timestamp: '2026-07-16T12:00:00.000Z',
  },
};

const minimal: UsageSignal = {
  id: '01KXKEGVPX65FSRWVCHS9QZYCX',
  kind: 'cites',
  item_id: 'T-046',
  source: { capture_point: 'record_append', session_id: 'sess-2', timestamp: '2026-07-16T12:01:00.000Z' },
};

describe('serialize/parse round-trip', () => {
  it('is identity for a full signal', () => {
    expect(parseUsageSignal(serializeUsageSignal(full))).toEqual(full);
  });

  it('is identity for a minimal signal (no optional ids / task_id)', () => {
    expect(parseUsageSignal(serializeUsageSignal(minimal))).toEqual(minimal);
  });

  it('emits a single line with a deterministic key order', () => {
    const line = serializeUsageSignal(minimal);
    expect(line).not.toContain('\n');
    expect(line).toBe(
      '{"id":"01KXKEGVPX65FSRWVCHS9QZYCX","kind":"cites","item_id":"T-046","source":' +
        '{"capture_point":"record_append","session_id":"sess-2","timestamp":"2026-07-16T12:01:00.000Z"}}',
    );
  });
});

describe('validateUsageSignal — required fields', () => {
  it('rejects an empty item_id', () => {
    expect(() => validateUsageSignal({ ...minimal, item_id: '' })).toThrow(UsageSchemaError);
  });

  it('rejects an absent source', () => {
    const { source: _omit, ...noSource } = minimal;
    expect(() => validateUsageSignal(noSource)).toThrow(UsageSchemaError);
  });

  it('rejects a missing session_id with a dotted field path', () => {
    try {
      validateUsageSignal({ ...minimal, source: { capture_point: 'x', timestamp: 't' } });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageSchemaError);
      expect((err as UsageSchemaError).field).toBe('source.session_id');
    }
  });

  it('rejects an empty optional id when present', () => {
    expect(() => validateUsageSignal({ ...minimal, seed_id: '' })).toThrow(UsageSchemaError);
  });

  it('rejects a non-JSON parse line', () => {
    expect(() => parseUsageSignal('{not json')).toThrow(UsageSchemaError);
  });
});

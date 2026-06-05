import { describe, it, expect } from 'vitest';
import { isTransientFlushError } from '../server/tracking-buffer';

/**
 * Guards the flush-retry decision: a transient DB-connectivity failure must be
 * retried (age-bounded) instead of consuming the small MAX_FLUSH_RETRIES budget,
 * while a genuine/poison error must NOT be classified transient so the bounded
 * count-based cap still applies and a bad batch can't loop forever.
 */
describe('isTransientFlushError', () => {
  it('treats pool checkout timeout as transient', () => {
    expect(isTransientFlushError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it('treats connection-class SQLSTATEs as transient', () => {
    for (const code of ['57P01', '08006', '08001', '08004', '08003', '08000', '57P03', '53300']) {
      expect(isTransientFlushError(Object.assign(new Error('conn'), { code }))).toBe(true);
    }
  });

  it('treats socket errors as transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']) {
      expect(isTransientFlushError(Object.assign(new Error('socket'), { code }))).toBe(true);
    }
  });

  it('treats "connection terminated" / "server closed the connection" as transient', () => {
    expect(isTransientFlushError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientFlushError(new Error('server closed the connection unexpectedly'))).toBe(true);
  });

  it('does NOT treat data/constraint errors as transient', () => {
    // 23505 = unique_violation, 23502 = not_null_violation, 22P02 = invalid_text_representation
    for (const code of ['23505', '23502', '22P02', '42703']) {
      expect(isTransientFlushError(Object.assign(new Error('bad data'), { code }))).toBe(false);
    }
    expect(isTransientFlushError(new Error('duplicate key value violates unique constraint'))).toBe(false);
  });

  it('is safe on null/undefined', () => {
    expect(isTransientFlushError(null)).toBe(false);
    expect(isTransientFlushError(undefined)).toBe(false);
  });
});

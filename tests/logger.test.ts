import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Logger Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('logger module exports expected functions', async () => {
    const loggerModule = await import('../server/logger');
    expect(loggerModule.logger).toBeDefined();
    expect(typeof loggerModule.logger.info).toBe('function');
    expect(typeof loggerModule.logger.warn).toBe('function');
    expect(typeof loggerModule.logger.error).toBe('function');
    expect(typeof loggerModule.logger.debug).toBe('function');
    expect(typeof loggerModule.logger.fatal).toBe('function');
  });
});

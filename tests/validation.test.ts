import { describe, it, expect } from 'vitest';
import { insertSubscriberSchema, insertSegmentSchema, insertMtaSchema, segmentRulesArraySchema } from '../shared/schema';

describe('Schema Validation', () => {
  describe('Subscriber Schema', () => {
    it('accepts valid subscriber data', () => {
      const result = insertSubscriberSchema.safeParse({
        email: 'test@example.com',
        tags: ['tag1', 'tag2'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid email', () => {
      const result = insertSubscriberSchema.safeParse({
        email: 'not-an-email',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Segment Rules Schema', () => {
    it('accepts valid rules array', () => {
      const result = segmentRulesArraySchema.safeParse([
        { field: 'email', operator: 'contains', value: '@example.com' }
      ]);
      expect(result.success).toBe(true);
    });

    it('accepts nested rule groups', () => {
      const result = segmentRulesArraySchema.safeParse([
        { field: 'email', operator: 'contains', value: '@test.com' },
        { type: 'group', logic: 'AND', combinator: 'OR', rules: [
          { field: 'tags', operator: 'contains', value: 'premium' }
        ]}
      ]);
      expect(result.success).toBe(true);
    });

    it('rejects invalid field names', () => {
      const result = segmentRulesArraySchema.safeParse([
        { field: 'invalid_field', operator: 'contains', value: 'test' }
      ]);
      expect(result.success).toBe(false);
    });
  });

  describe('MTA Schema', () => {
    it('accepts valid MTA config', () => {
      const result = insertMtaSchema.safeParse({
        name: 'Test MTA',
        hostname: 'smtp.example.com',
        port: 587,
      });
      expect(result.success).toBe(true);
    });
  });
});

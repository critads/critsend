import { describe, it, expect } from 'vitest';
import { signTrackingUrl, verifyTrackingSignature } from '../server/tracking';

describe('Tracking URL Signing', () => {
  const campaignId = 'test-campaign-123';
  const subscriberId = 'test-subscriber-456';

  it('signs and verifies open tracking', () => {
    const sig = signTrackingUrl(campaignId, subscriberId, 'open');
    expect(sig).toHaveLength(64);
    expect(verifyTrackingSignature(campaignId, subscriberId, 'open', sig)).toBe(true);
  });

  it('signs and verifies click tracking with URL', () => {
    const url = 'https://example.com/page';
    const sig = signTrackingUrl(campaignId, subscriberId, 'click', url);
    expect(verifyTrackingSignature(campaignId, subscriberId, 'click', sig, url)).toBe(true);
  });

  it('rejects invalid signatures', () => {
    expect(verifyTrackingSignature(campaignId, subscriberId, 'open', 'invalid-sig')).toBe(false);
  });

  it('rejects tampered campaign IDs', () => {
    const sig = signTrackingUrl(campaignId, subscriberId, 'open');
    expect(verifyTrackingSignature('tampered-id', subscriberId, 'open', sig)).toBe(false);
  });

  it('rejects tampered URLs in click tracking', () => {
    const url = 'https://example.com/page';
    const sig = signTrackingUrl(campaignId, subscriberId, 'click', url);
    expect(verifyTrackingSignature(campaignId, subscriberId, 'click', sig, 'https://evil.com')).toBe(false);
  });

  it('generates different signatures for different types', () => {
    const openSig = signTrackingUrl(campaignId, subscriberId, 'open');
    const clickSig = signTrackingUrl(campaignId, subscriberId, 'click');
    const unsubSig = signTrackingUrl(campaignId, subscriberId, 'unsubscribe');
    expect(openSig).not.toEqual(clickSig);
    expect(clickSig).not.toEqual(unsubSig);
  });
});

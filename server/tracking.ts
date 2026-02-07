import crypto from "crypto";

function getTrackingSecret(): string {
  const secret = process.env.TRACKING_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("TRACKING_SECRET or SESSION_SECRET environment variable is required for secure tracking URLs");
  }
  return secret;
}

const TRACKING_SECRET = getTrackingSecret();

export type TrackingType = "open" | "click" | "unsubscribe";

export function signTrackingUrl(
  campaignId: string,
  subscriberId: string,
  type: TrackingType,
  url?: string
): string {
  const payload = url 
    ? `${campaignId}:${subscriberId}:${type}:${url}`
    : `${campaignId}:${subscriberId}:${type}`;
  
  const signature = crypto
    .createHmac("sha256", TRACKING_SECRET)
    .update(payload)
    .digest("hex");
  
  return signature;
}

export function verifyTrackingSignature(
  campaignId: string,
  subscriberId: string,
  type: TrackingType,
  signature: string,
  url?: string
): boolean {
  const expectedSignature = signTrackingUrl(campaignId, subscriberId, type, url);
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

export function generateSignedOpenTrackingUrl(
  baseUrl: string,
  campaignId: string,
  subscriberId: string
): string {
  const sig = signTrackingUrl(campaignId, subscriberId, "open");
  return `${baseUrl}/api/track/open/${campaignId}/${subscriberId}?sig=${sig}`;
}

export function generateSignedClickTrackingUrl(
  baseUrl: string,
  campaignId: string,
  subscriberId: string,
  destinationUrl: string
): string {
  const sig = signTrackingUrl(campaignId, subscriberId, "click", destinationUrl);
  const encodedUrl = encodeURIComponent(destinationUrl);
  return `${baseUrl}/api/track/click/${campaignId}/${subscriberId}?url=${encodedUrl}&sig=${sig}`;
}

export function generateSignedUnsubscribeUrl(
  baseUrl: string,
  campaignId: string,
  subscriberId: string
): string {
  const sig = signTrackingUrl(campaignId, subscriberId, "unsubscribe");
  return `${baseUrl}/api/unsubscribe/${campaignId}/${subscriberId}?sig=${sig}`;
}

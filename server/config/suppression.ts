/**
 * Unsubscribe cooling-off window (in days).
 *
 * When a contact unsubscribes, `subscribers.suppressed_until` is set to
 * NOW() + UNSUBSCRIBE_COOLING_OFF_DAYS. Every audience-selection query
 * (segment compiler + subscriber repository) excludes contacts whose
 * suppressed_until is still in the future, so they receive no campaigns during
 * this window. Once it expires, the contact becomes eligible again.
 *
 * NOTE: the duration is baked in at WRITE time (not evaluated at read time),
 * so changing this constant only affects unsubscribes recorded AFTER the
 * change ships. To apply a new window to already-suppressed contacts, update
 * their `suppressed_until` directly in the database.
 */
export const UNSUBSCRIBE_COOLING_OFF_DAYS = 21;

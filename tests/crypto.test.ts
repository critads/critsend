import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncrypted } from '../server/crypto';

describe('Crypto Module', () => {
  it('encrypts and decrypts text correctly', () => {
    const plaintext = 'my-smtp-password-123';
    const encrypted = encrypt(plaintext);
    expect(encrypted.startsWith('enc:')).toBe(true);
    expect(encrypted).not.toEqual(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it('returns plaintext as-is for non-encrypted strings', () => {
    const plaintext = 'legacy-password';
    expect(decrypt(plaintext)).toEqual(plaintext);
  });

  it('isEncrypted detects encrypted strings', () => {
    const encrypted = encrypt('test');
    expect(isEncrypted(encrypted)).toBe(true);
    expect(isEncrypted('plaintext')).toBe(false);
  });

  it('produces unique ciphertexts for same plaintext', () => {
    const encrypted1 = encrypt('same-password');
    const encrypted2 = encrypt('same-password');
    expect(encrypted1).not.toEqual(encrypted2);
    expect(decrypt(encrypted1)).toEqual(decrypt(encrypted2));
  });
});

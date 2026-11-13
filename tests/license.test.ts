import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, session: {} }));

const { normalizeKey, verifyToken } = await import('../electron/license');
const { formatKeyInput } = await import('../src/ui/license/LicenseDialog');

describe('license keys', () => {
  it('normalizes pasted keys like the server does', () => {
    expect(normalizeKey('FE-HG7KQ-2MXP4-ZT9RW-C3JN8')).toBe('FE-HG7KQ-2MXP4-ZT9RW-C3JN8');
    expect(normalizeKey(' fe hg7kq 2mxp4 zt9rw c3jn8 ')).toBe('FE-HG7KQ-2MXP4-ZT9RW-C3JN8');
    expect(normalizeKey('HG7KQ2MXP4ZT9RWC3JN8')).toBe('FE-HG7KQ-2MXP4-ZT9RW-C3JN8');
  });

  it('rejects keys with look-alike or missing characters', () => {
    expect(normalizeKey('FE-HG7KQ-2MXP4-ZT9RW-C3JN')).toBeNull();
    expect(normalizeKey('FE-HG7KQ-2MXP4-ZT9RW-C3JN0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeKey('FE-HG7KQ-2MXP4-ZT9RW-C3JNI')).toBeNull(); // nor is I
    expect(normalizeKey(42)).toBeNull();
  });

  it('formats the key while it is typed without auto-inserting FE-', () => {
    expect(formatKeyInput('hg7kq2mx')).toBe('HG7KQ-2MX');
    expect(formatKeyInput('fehg7kq2mx')).toBe('FE-HG7KQ-2MX');
    expect(formatKeyInput('FE-HG7KQ-2MXP4-ZT9RW-C3JN8-EXTRA')).toBe('FE-HG7KQ-2MXP4-ZT9RW-C3JN8');
    expect(formatKeyInput('')).toBe('');
  });

  it('rejects tokens that are not signed by the license server', () => {
    const dev = 'a'.repeat(64);
    const payload = Buffer.from(JSON.stringify({ typ: 'file-editor-license', lid: 'lic_x', hint: '…-AAAAA', email: 'a@b.c', dev, iat: 1 })).toString('base64url');
    expect(verifyToken(`FE1.${payload}.${Buffer.alloc(64).toString('base64url')}`, dev)).toBeNull();
    expect(verifyToken('garbage', dev)).toBeNull();
    expect(verifyToken(undefined, dev)).toBeNull();
  });
});

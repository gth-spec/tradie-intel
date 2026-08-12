import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '@/lib/token';

interface TestPayload { who: string; exp: number; }

const SECRET = 'test-secret-value';
const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 10;

describe('signToken / verifyToken', () => {
  it('round-trips a payload', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: future() }, SECRET);
    expect(verifyToken<TestPayload>(token, SECRET).who).toBe('a@b.com');
  });

  it('rejects a tampered payload', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: future() }, SECRET);
    const forged = Buffer.from(JSON.stringify({ who: 'evil@b.com', exp: future() })).toString('base64url');
    const tampered = `${forged}.${token.slice(token.indexOf('.') + 1)}`;
    expect(() => verifyToken<TestPayload>(tampered, SECRET)).toThrow(/signature/i);
  });

  it('rejects a tampered signature', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: future() }, SECRET);
    expect(() => verifyToken<TestPayload>(`${token}x`, SECRET)).toThrow(/signature/i);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: future() }, 'other-secret');
    expect(() => verifyToken<TestPayload>(token, SECRET)).toThrow(/signature/i);
  });

  it('rejects an expired token', () => {
    const token = signToken<TestPayload>({ who: 'a@b.com', exp: past() }, SECRET);
    expect(() => verifyToken<TestPayload>(token, SECRET)).toThrow(/expired/i);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyToken<TestPayload>('no-dot-here', SECRET)).toThrow(/format/i);
  });
});

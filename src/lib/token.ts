import { createHmac, timingSafeEqual } from 'node:crypto';

/** Every token payload carries its own expiry as unix seconds. */
export interface ExpiringPayload {
  exp: number;
}

/** Wire format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>` */
export function signToken<T extends ExpiringPayload>(payload: T, secret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/** Throws on malformed, tampered, or expired tokens. Never returns a partial result. */
export function verifyToken<T extends ExpiringPayload>(token: string, secret: string): T {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) throw new Error('Invalid token format');
  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);

  const expected = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const expectedBuf = Buffer.from(expected, 'ascii');
  const sigBuf = Buffer.from(sig, 'ascii');
  // Length check first: timingSafeEqual throws on length mismatch.
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid token signature');
  }

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as T;
  } catch {
    throw new Error('Invalid token format');
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

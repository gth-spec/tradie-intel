import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryProvider, ResendProvider, NitrosendProvider, KitProvider, DualProvider, isValidEmail, type SubscribeMeta } from '@/lib/email';

const META: SubscribeMeta = {
  consent: true,
  consent_timestamp: '2026-05-23T00:00:00Z',
  source: 'homepage-hero',
  referrer: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
};

describe('isValidEmail', () => {
  it('accepts valid emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('a.b+c@sub.example.com.au')).toBe(true);
  });
  it('rejects obvious junk', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('@nodomain')).toBe(false);
    expect(isValidEmail('no@tld')).toBe(false);
  });
});

describe('MemoryProvider', () => {
  let provider: MemoryProvider;
  beforeEach(() => { provider = new MemoryProvider(); });

  it('stores a subscriber', async () => {
    await provider.subscribe('a@b.com', META);
    expect(provider.list()).toEqual(['a@b.com']);
  });

  it('de-dupes', async () => {
    await provider.subscribe('a@b.com', META);
    await provider.subscribe('a@b.com', META);
    expect(provider.list()).toEqual(['a@b.com']);
  });

  it('rejects invalid emails', async () => {
    await expect(provider.subscribe('garbage', META)).rejects.toThrow(/invalid email/i);
  });

  it('records the most recent meta for retrieval', async () => {
    await provider.subscribe('a@b.com', META);
    expect(provider.lastMeta()).toMatchObject({
      source: 'homepage-hero', consent: true
    });
  });
});

const meta: SubscribeMeta = {
  consent: true,
  consent_timestamp: '2026-05-27T00:00:00.000Z',
  source: 'tradieintel.com.au',
  referrer: null,
  utm_source: 'organic',
  utm_medium: null,
  utm_campaign: null
};

describe('ResendProvider.subscribe', () => {
  beforeEach(() => { vi.spyOn(global, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POSTs /contacts with email, segments[{id}], and utm/consent in properties', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'contact', id: 'c-1' }), { status: 200 })
    );
    const p = new ResendProvider('re_key', 'seg-1');
    await p.subscribe('user@example.com', meta);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.resend.com/contacts');
    expect(init.headers['Authorization']).toBe('Bearer re_key');
    const body = JSON.parse(init.body);
    expect(body.email).toBe('user@example.com');
    expect(body.segments).toEqual([{ id: 'seg-1' }]);
    expect(body.unsubscribed).toBe(false);
    expect(body.properties).toEqual(expect.objectContaining({
      source: 'tradieintel.com.au',
      utm_source: 'organic',
      consent_at: '2026-05-27T00:00:00.000Z'
    }));
  });

  it('rejects invalid email before any fetch', async () => {
    const p = new ResendProvider('re_key', 'seg-1');
    await expect(p.subscribe('not-an-email', meta)).rejects.toThrow('Invalid email');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('treats 422 "already exists" as success (idempotent re-subscribe)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Contact already exists' }), { status: 422 })
    );
    const p = new ResendProvider('re_key', 'seg-1');
    await expect(p.subscribe('user@example.com', meta)).resolves.toBeUndefined();
  });

  it('throws on other non-2xx responses', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('forbidden', { status: 403 })
    );
    const p = new ResendProvider('re_key', 'seg-1');
    await expect(p.subscribe('user@example.com', meta)).rejects.toThrow('Resend contact create error: 403');
  });

  it('sets unsubscribed: true when meta.consent is false', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'contact', id: 'c-1' }), { status: 200 })
    );
    const p = new ResendProvider('re_key', 'seg-1');
    await p.subscribe('user@example.com', { ...meta, consent: false });
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.unsubscribed).toBe(true);
  });
});

describe('NitrosendProvider.subscribe', () => {
  beforeEach(() => { vi.spyOn(global, 'fetch'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('POSTs /contacts then /lists/{id}/contacts/bulk with correct bodies and auth', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'c-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ added: 1 }), { status: 200 }));

    const p = new NitrosendProvider('ns_key', 'list-42');
    await p.subscribe('user@example.com', meta);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    // First call: create contact
    const [url1, init1] = calls[0];
    expect(url1).toBe('https://api.nitrosend.com/v1/my/contacts');
    expect(init1.method).toBe('POST');
    expect(init1.headers['Authorization']).toBe('Bearer ns_key');
    expect(init1.headers['Content-Type']).toBe('application/json');
    const body1 = JSON.parse(init1.body);
    expect(body1.email).toBe('user@example.com');
    expect(body1.opt_in).toBe(true);

    // Second call: add to list
    const [url2, init2] = calls[1];
    expect(url2).toBe('https://api.nitrosend.com/v1/my/lists/list-42/contacts/bulk');
    expect(init2.method).toBe('POST');
    expect(init2.headers['Authorization']).toBe('Bearer ns_key');
    const body2 = JSON.parse(init2.body);
    expect(body2).toEqual({ action: 'add', emails: ['user@example.com'] });
  });

  it('rejects an invalid email before any fetch', async () => {
    const p = new NitrosendProvider('ns_key', 'list-42');
    await expect(p.subscribe('not-an-email', meta)).rejects.toThrow('Invalid email');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('treats 422 on contact-create as success and still does the list add', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'already exists' }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ added: 1 }), { status: 200 }));

    const p = new NitrosendProvider('ns_key', 'list-42');
    await expect(p.subscribe('user@example.com', meta)).resolves.toBeUndefined();

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe('https://api.nitrosend.com/v1/my/lists/list-42/contacts/bulk');
  });

  it('sets opt_in: false when meta.consent is false', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'c-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ added: 1 }), { status: 200 }));

    const p = new NitrosendProvider('ns_key', 'list-42');
    await p.subscribe('user@example.com', { ...meta, consent: false });

    const body1 = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body1.opt_in).toBe(false);
  });
});

describe('getProvider', () => {
  // Save and restore process.env around each test so env mutations don't bleed.
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
      EMAIL_PROVIDER_API_KEY: process.env.EMAIL_PROVIDER_API_KEY,
      EMAIL_LIST_ID: process.env.EMAIL_LIST_ID,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESEND_SEGMENT_ID: process.env.RESEND_SEGMENT_ID,
      NITROSEND_API_KEY: process.env.NITROSEND_API_KEY,
      NITROSEND_LIST_ID: process.env.NITROSEND_LIST_ID,
    };
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  it('EMAIL_PROVIDER=dual returns DualProvider with Kit primary and NitroSend secondary', async () => {
    process.env.EMAIL_PROVIDER = 'dual';
    process.env.EMAIL_PROVIDER_API_KEY = 'kit_key';
    process.env.EMAIL_LIST_ID = 'kit_form_id';
    process.env.NITROSEND_API_KEY = 'ns_key';
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    // Import all class refs from the same fresh module so instanceof checks use
    // the same constructor identity as the one getProvider() used to build the object.
    const email = await import('@/lib/email');
    const p = email.getProvider();

    expect(p).toBeInstanceOf(email.DualProvider);
    expect((p as any).primary).toBeInstanceOf(email.KitProvider);
    expect((p as any).secondary).toBeInstanceOf(email.NitrosendProvider);
  });

  it('EMAIL_PROVIDER=nitrosend throws when NITROSEND_API_KEY is missing', async () => {
    process.env.EMAIL_PROVIDER = 'nitrosend';
    delete process.env.NITROSEND_API_KEY;
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(() => getProvider()).toThrow(/NITROSEND_API_KEY/);
  });

  it('EMAIL_PROVIDER=nitrosend throws when NITROSEND_LIST_ID is missing', async () => {
    process.env.EMAIL_PROVIDER = 'nitrosend';
    process.env.NITROSEND_API_KEY = 'ns_key';
    delete process.env.NITROSEND_LIST_ID;

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(() => getProvider()).toThrow(/NITROSEND_LIST_ID/);
  });

  it('EMAIL_PROVIDER=nitrosend returns NitrosendProvider when env is complete', async () => {
    process.env.EMAIL_PROVIDER = 'nitrosend';
    process.env.NITROSEND_API_KEY = 'ns_key';
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    // Same-module import so instanceof uses the same constructor identity.
    const email = await import('@/lib/email');
    const p = email.getProvider();

    expect(p).toBeInstanceOf(email.NitrosendProvider);
  });

  it('EMAIL_PROVIDER=dual throws when NITROSEND_API_KEY is missing', async () => {
    process.env.EMAIL_PROVIDER = 'dual';
    process.env.EMAIL_PROVIDER_API_KEY = 'kit_key';
    process.env.EMAIL_LIST_ID = 'kit_form_id';
    delete process.env.NITROSEND_API_KEY;
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(() => getProvider()).toThrow(/NITROSEND_API_KEY/);
  });

  it('EMAIL_PROVIDER=dual throws when EMAIL_PROVIDER_API_KEY is missing', async () => {
    process.env.EMAIL_PROVIDER = 'dual';
    delete process.env.EMAIL_PROVIDER_API_KEY;
    process.env.EMAIL_LIST_ID = 'kit_form_id';
    process.env.NITROSEND_API_KEY = 'ns_key';
    process.env.NITROSEND_LIST_ID = 'ns_list_id';

    vi.resetModules();
    const { getProvider } = await import('@/lib/email');
    expect(() => getProvider()).toThrow(/EMAIL_PROVIDER_API_KEY/);
  });
});

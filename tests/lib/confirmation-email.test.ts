import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildConfirmationHtml, sendConfirmationEmail } from '@/lib/confirmation-email';

const links = [
  { scope: 'tradieintel_digest' as const, url: 'https://x.test/confirm?t=aaa', label: 'Confirm the weekly digest' },
  { scope: 'grokoryai_commercial' as const, url: 'https://x.test/confirm?t=bbb', label: 'Confirm GrokoryAI emails' }
];

describe('buildConfirmationHtml', () => {
  it('includes one link per scope', () => {
    const html = buildConfirmationHtml(links);
    expect(html).toContain('https://x.test/confirm?t=aaa');
    expect(html).toContain('https://x.test/confirm?t=bbb');
  });

  it('states that ignoring the email means nothing further is sent', () => {
    expect(buildConfirmationHtml(links).toLowerCase()).toContain('ignore');
  });

  it('renders only the digest link when only the digest was requested', () => {
    const html = buildConfirmationHtml([links[0]]);
    expect(html).toContain('aaa');
    expect(html).not.toContain('bbb');
  });

  it('includes the digest description when the digest scope is requested', () => {
    // Assert on prose unique to the description paragraph, not the button
    // label ("Confirm the weekly digest") — the label renders unconditionally
    // for any digest link, so asserting on "weekly digest" alone would pass
    // even if the conditional paragraph were never rendered.
    expect(buildConfirmationHtml([links[0]]).toLowerCase()).toContain('ai-filtered trades news');
  });

  it('omits the digest description when only grokoryai_commercial is requested', () => {
    expect(buildConfirmationHtml([links[1]]).toLowerCase()).not.toContain('ai-filtered trades news');
  });

  it('throws when given an empty links array', () => {
    expect(() => buildConfirmationHtml([])).toThrow();
  });
});

describe('sendConfirmationEmail', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to the Resend endpoint with bearer auth and a List-Unsubscribe header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"e1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendConfirmationEmail('a@b.com', links, 'test-key');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['a@b.com']);
    expect(body.from).toContain('hello@tradieintel.com.au');
    expect(body.headers['List-Unsubscribe']).toBeTruthy();
  });

  it('throws when Resend returns a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 422 })));
    await expect(sendConfirmationEmail('a@b.com', links, 'test-key')).rejects.toThrow(/422/);
  });

  it('throws on an empty links array without sending any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendConfirmationEmail('a@b.com', [], 'test-key')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── createNitrosendCampaign ───────────────────────────────────────────────────

describe('createNitrosendCampaign', () => {
  const API_KEY = 'ns_test_key';
  const BASE = 'https://api.nitrosend.com/v1/my';

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function makeFetchSequence() {
    // Step 1: POST /campaigns → campaign id 42
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 42, status: 'draft' }), { status: 200 })
    );
    // Step 2: GET /campaigns/42 → bound template id 99, version 1
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 42, template: { id: 99, version: 1 } }),
        { status: 200 }
      )
    );
    // Step 3: PATCH /templates/99 → 200
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 99, version: 2 }), { status: 200 })
    );
    // Step 4: PATCH /campaigns/42 audience → 200
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 42 }), { status: 200 })
    );
  }

  it('makes 4 calls in the correct order to the correct URLs', async () => {
    makeFetchSequence();
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await createNitrosendCampaign(API_KEY, {
      listId: '265',
      subject: 'Test subject',
      name: 'Test campaign',
      sections: []
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [url0] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url0).toBe(`${BASE}/campaigns`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');

    const [url1] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url1).toBe(`${BASE}/campaigns/42`);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('GET');

    const [url2] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url2).toBe(`${BASE}/templates/99`);
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('PATCH');

    const [url3] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(url3).toBe(`${BASE}/campaigns/42`);
    expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBe('PATCH');
  });

  it('step 1 POST /campaigns body contains name and channel=email', async () => {
    makeFetchSequence();
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await createNitrosendCampaign(API_KEY, {
      listId: '265',
      subject: 'Sub',
      name: 'My Campaign',
      sections: []
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ name: 'My Campaign', channel: 'email' });
  });

  it('step 3 PATCH /templates includes subject, preheader, if_version, and design sections', async () => {
    makeFetchSequence();
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    const sections = [{ type: 'header', props: {} }, { type: 'footer' }];
    await createNitrosendCampaign(API_KEY, {
      listId: '265',
      subject: 'My Subject',
      preheader: 'My preheader',
      name: 'Camp',
      sections
    });

    const body = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(body.subject).toBe('My Subject');
    expect(body.preheader).toBe('My preheader');
    expect(body.if_version).toBe(1);
    expect(body.design).toEqual({ version: 2, theme: {}, sections });
  });

  it('step 3 PATCH /templates omits preheader when not provided', async () => {
    makeFetchSequence();
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await createNitrosendCampaign(API_KEY, {
      listId: '265',
      subject: 'Sub',
      name: 'Camp',
      sections: []
    });

    const body = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect('preheader' in body).toBe(false);
  });

  it('step 4 PATCH /campaigns sets trigger_attributes with listId as number, no template_id', async () => {
    makeFetchSequence();
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await createNitrosendCampaign(API_KEY, {
      listId: '265',
      subject: 'Sub',
      name: 'Camp',
      sections: []
    });

    const body = JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string);
    expect(body).toEqual({
      trigger_attributes: {
        event: 'manual',
        audience_type: 'lists',
        contact_list_ids: [265]
      }
    });
    expect('template_id' in body).toBe(false);
  });

  it('uses Bearer auth header on all calls', async () => {
    makeFetchSequence();
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await createNitrosendCampaign(API_KEY, {
      listId: '265', subject: 'S', name: 'N', sections: []
    });

    for (const call of fetchMock.mock.calls as [string, RequestInit][]) {
      const headers = call[1].headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    }
  });

  it('returns campaign id as a string', async () => {
    makeFetchSequence();
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    const id = await createNitrosendCampaign(API_KEY, {
      listId: '265', subject: 'S', name: 'N', sections: []
    });
    expect(id).toBe('42');
    expect(typeof id).toBe('string');
  });

  it('throws on step 1 non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await expect(
      createNitrosendCampaign(API_KEY, { listId: '265', subject: 'S', name: 'N', sections: [] })
    ).rejects.toThrow('Nitrosend campaigns create error: 401');
  });

  it('throws on step 2 non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 42 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response('Not Found', { status: 404 })
    );
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await expect(
      createNitrosendCampaign(API_KEY, { listId: '265', subject: 'S', name: 'N', sections: [] })
    ).rejects.toThrow('Nitrosend campaigns get error: 404');
  });

  it('throws on step 3 non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 42 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 42, template: { id: 99, version: 1 } }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response('Conflict', { status: 409 })
    );
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await expect(
      createNitrosendCampaign(API_KEY, { listId: '265', subject: 'S', name: 'N', sections: [] })
    ).rejects.toThrow('Nitrosend templates patch error: 409');
  });

  it('throws on step 4 non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 42 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 42, template: { id: 99, version: 1 } }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 99 }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response('Unprocessable', { status: 422 })
    );
    const { createNitrosendCampaign } = await import('@/lib/nitrosend');
    await expect(
      createNitrosendCampaign(API_KEY, { listId: '265', subject: 'S', name: 'N', sections: [] })
    ).rejects.toThrow('Nitrosend campaigns audience patch error: 422');
  });
});

// ── sendNitrosendCampaign ─────────────────────────────────────────────────────

describe('sendNitrosendCampaign', () => {
  const API_KEY = 'ns_test_key';
  const BASE = 'https://api.nitrosend.com/v1/my';

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('POSTs to /campaigns/{id}/send with empty body and Bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { sendNitrosendCampaign } = await import('@/lib/nitrosend');
    await sendNitrosendCampaign(API_KEY, '42');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/campaigns/42/send`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Bad request', { status: 400 }));
    const { sendNitrosendCampaign } = await import('@/lib/nitrosend');
    await expect(sendNitrosendCampaign(API_KEY, '42'))
      .rejects.toThrow('Nitrosend campaign send error: 400');
  });

  it('resolves void on success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { sendNitrosendCampaign } = await import('@/lib/nitrosend');
    const result = await sendNitrosendCampaign(API_KEY, '42');
    expect(result).toBeUndefined();
  });
});

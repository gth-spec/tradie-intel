// NitroSend REST client
// Base: https://api.nitrosend.com/v1/my — Bearer apiKey
// Campaign send sequence confirmed per docs/nitrosend-api-probe.md (2026-06-20):
//   1. POST /campaigns → get campaign id
//   2. GET /campaigns/{id} → get bound template id + version
//   3. PATCH /templates/{boundTemplateId} → set content (if_version required)
//   4. PATCH /campaigns/{id} → set audience (trigger_attributes only; NO template_id)
// Note: campaign auto-creates its own bound template; do NOT create a standalone
//       template and do NOT PATCH template_id onto the campaign.

const BASE_URL = 'https://api.nitrosend.com/v1/my';

function headers(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };
}

export interface CreateNitrosendCampaignInput {
  listId: string;
  subject: string;
  name: string;
  preheader?: string;
  sections: unknown[];
}

/**
 * Creates a NitroSend campaign, sets its bound template content,
 * wires the audience, and returns the campaign id as a string.
 *
 * Sequence (per docs/nitrosend-api-probe.md):
 *   Step 1 — POST /campaigns
 *   Step 2 — GET  /campaigns/{id}   (read bound template id + version)
 *   Step 3 — PATCH /templates/{id}  (set design; if_version required)
 *   Step 4 — PATCH /campaigns/{id}  (set audience via trigger_attributes)
 */
export async function createNitrosendCampaign(
  apiKey: string,
  input: CreateNitrosendCampaignInput
): Promise<string> {
  const { listId, subject, name, preheader, sections } = input;

  // Step 1: Create campaign
  const res1 = await fetch(`${BASE_URL}/campaigns`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ name, channel: 'email' })
  });
  if (!res1.ok) {
    throw new Error(`Nitrosend campaigns create error: ${res1.status} ${await res1.text()}`);
  }
  const data1 = await res1.json() as { id: number };
  const campaignId = data1.id;

  // Step 2: Read bound template id and version
  const res2 = await fetch(`${BASE_URL}/campaigns/${campaignId}`, {
    method: 'GET',
    headers: headers(apiKey)
  });
  if (!res2.ok) {
    throw new Error(`Nitrosend campaigns get error: ${res2.status} ${await res2.text()}`);
  }
  const data2 = await res2.json() as { id: number; template: { id: number; version: number } };
  const boundTemplateId = data2.template.id;
  const templateVersion = data2.template.version;

  // Step 3: Patch bound template with content (if_version is required for optimistic concurrency)
  const templateBody: Record<string, unknown> = {
    subject,
    if_version: templateVersion,
    design: { version: 2, theme: {}, sections }
  };
  if (preheader !== undefined) {
    templateBody.preheader = preheader;
  }

  const res3 = await fetch(`${BASE_URL}/templates/${boundTemplateId}`, {
    method: 'PATCH',
    headers: headers(apiKey),
    body: JSON.stringify(templateBody)
  });
  if (!res3.ok) {
    throw new Error(`Nitrosend templates patch error: ${res3.status} ${await res3.text()}`);
  }

  // Step 4: Set audience on campaign (trigger_attributes only — never include template_id)
  const res4 = await fetch(`${BASE_URL}/campaigns/${campaignId}`, {
    method: 'PATCH',
    headers: headers(apiKey),
    body: JSON.stringify({
      trigger_attributes: {
        event: 'manual',
        audience_type: 'lists',
        contact_list_ids: [Number(listId)]
      }
    })
  });
  if (!res4.ok) {
    throw new Error(`Nitrosend campaigns audience patch error: ${res4.status} ${await res4.text()}`);
  }

  return String(campaignId);
}

const KIT_BASE_URL = 'https://api.kit.com/v4';
const BULK_CHUNK_SIZE = 200;

/**
 * Reconciles the NitroSend send-list from Kit (system of record).
 * Pages through all Kit form subscribers and bulk-adds them to the NitroSend list.
 * Returns the total number of emails reconciled.
 *
 * Call this before sending a digest so a missed dual-write can't silently
 * drop a recipient. Reconcile failure should be caught by the caller and
 * logged without blocking the send.
 */
export async function reconcileNitrosendList(
  nitroKey: string,
  listId: string,
  kitKey: string,
  kitFormId: string
): Promise<number> {
  // Collect all subscriber emails from Kit, following pagination
  const emails: string[] = [];
  let after: string | null = null;

  while (true) {
    const url = new URL(`${KIT_BASE_URL}/forms/${kitFormId}/subscribers`);
    url.searchParams.set('per_page', '500');
    if (after !== null) {
      url.searchParams.set('after', after);
    }

    const kitRes = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-Kit-Api-Key': kitKey }
    });
    if (!kitRes.ok) {
      const text = await kitRes.text();
      throw new Error(`Kit list subscribers error: ${kitRes.status} ${text}`);
    }

    const data = await kitRes.json() as {
      subscribers: Array<{ email_address: string }>;
      pagination: { has_next_page: boolean; end_cursor: string | null };
    };

    for (const sub of data.subscribers) {
      emails.push(sub.email_address);
    }

    if (!data.pagination.has_next_page) break;
    after = data.pagination.end_cursor;
  }

  // Ensure each email exists as a NitroSend contact FIRST. The bulk-add
  // endpoint only adds contacts that already exist — net-new emails come back
  // as not_found and are silently skipped (which would leave the send list
  // empty). Kit form subscribers are confirmed + consented, so create them
  // opt_in:true, then add to the list. (For very large lists, POST /imports
  // CSV would beat per-email creates given the 2 req/s limit; fine at current volume.)
  for (const email of emails) {
    const contactRes = await fetch(`${BASE_URL}/contacts`, {
      method: 'POST',
      headers: headers(nitroKey),
      body: JSON.stringify({ email, opt_in: true })
    });
    if (!contactRes.ok && contactRes.status !== 422) {
      const text = await contactRes.text();
      throw new Error(`Nitrosend contact create error: ${contactRes.status} ${text}`);
    }
  }

  // Bulk-add all collected emails to NitroSend in chunks of 200 (now they exist)
  for (let i = 0; i < emails.length; i += BULK_CHUNK_SIZE) {
    const chunk = emails.slice(i, i + BULK_CHUNK_SIZE);
    const nitroRes = await fetch(`${BASE_URL}/lists/${listId}/contacts/bulk`, {
      method: 'POST',
      headers: headers(nitroKey),
      body: JSON.stringify({ action: 'add', emails: chunk })
    });
    if (!nitroRes.ok) {
      const text = await nitroRes.text();
      throw new Error(`Nitrosend bulk add error: ${nitroRes.status} ${text}`);
    }
  }

  return emails.length;
}

/**
 * Sends a NitroSend campaign immediately.
 * POST /campaigns/{campaignId}/send
 */
export async function sendNitrosendCampaign(
  apiKey: string,
  campaignId: string
): Promise<void> {
  const res = await fetch(`${BASE_URL}/campaigns/${campaignId}/send`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({})
  });
  if (!res.ok) {
    throw new Error(`Nitrosend campaign send error: ${res.status} ${await res.text()}`);
  }
}

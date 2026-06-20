export interface SubscribeMeta {
  consent: boolean;
  consent_timestamp: string;
  source: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

export interface EmailProvider {
  subscribe(email: string, meta: SubscribeMeta): Promise<void>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(s: string): boolean {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
}

export class MemoryProvider implements EmailProvider {
  private set = new Set<string>();
  private lastMetaObj: SubscribeMeta | null = null;
  async subscribe(email: string, meta: SubscribeMeta): Promise<void> {
    const trimmed = email.trim().toLowerCase();
    if (!isValidEmail(trimmed)) throw new Error('Invalid email');
    this.set.add(trimmed);
    this.lastMetaObj = meta;
  }
  list(): string[] { return Array.from(this.set); }
  lastMeta(): SubscribeMeta | null { return this.lastMetaObj; }
}

export class KitProvider implements EmailProvider {
  constructor(private apiKey: string, private formId: string) {}
  async subscribe(email: string, meta: SubscribeMeta): Promise<void> {
    if (!isValidEmail(email)) throw new Error('Invalid email');
    // Kit v4 API: POST /v4/subscribers with form_id in body.
    // /v4/forms/{id}/subscribers returns 404 in v4 despite appearing in older docs.
    const res = await fetch('https://api.kit.com/v4/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kit-Api-Key': this.apiKey
      },
      body: JSON.stringify({
        email_address: email,
        form_id: Number(this.formId),
        fields: {
          source: meta.source,
          utm_source: meta.utm_source,
          utm_medium: meta.utm_medium,
          utm_campaign: meta.utm_campaign,
          consent_at: meta.consent_timestamp
        }
      })
    });
    if (!res.ok) throw new Error(`Kit API error: ${res.status} ${await res.text()}`);
  }
}

export class MailchimpProvider implements EmailProvider {
  constructor(private apiKey: string, private listId: string) {}
  async subscribe(email: string, meta: SubscribeMeta): Promise<void> {
    if (!isValidEmail(email)) throw new Error('Invalid email');
    const dc = this.apiKey.split('-')[1];
    if (!dc) throw new Error('Invalid Mailchimp API key (no datacenter suffix)');
    const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${this.listId}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        email_address: email,
        status: 'pending',
        merge_fields: {
          SOURCE: meta.source,
          UTM_SRC: meta.utm_source ?? '',
          UTM_MED: meta.utm_medium ?? '',
          UTM_CAMP: meta.utm_campaign ?? ''
        }
      })
    });
    if (!res.ok && res.status !== 400) {
      throw new Error(`Mailchimp API error: ${res.status} ${await res.text()}`);
    }
  }
}

export class ResendProvider implements EmailProvider {
  constructor(private apiKey: string, private segmentId: string) {}
  async subscribe(email: string, meta: SubscribeMeta): Promise<void> {
    if (!isValidEmail(email)) throw new Error('Invalid email');
    const res = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        email,
        segments: [{ id: this.segmentId }],
        unsubscribed: !meta.consent,
        properties: {
          source: meta.source,
          referrer: meta.referrer ?? '',
          utm_source: meta.utm_source ?? '',
          utm_medium: meta.utm_medium ?? '',
          utm_campaign: meta.utm_campaign ?? '',
          consent_at: meta.consent_timestamp
        }
      })
    });
    if (res.status === 422) {
      const text = await res.text();
      if (/already exists/i.test(text)) return;
      throw new Error(`Resend contact create error: 422 ${text}`);
    }
    if (!res.ok) {
      throw new Error(`Resend contact create error: ${res.status} ${await res.text()}`);
    }
  }
}

export class NitrosendProvider implements EmailProvider {
  constructor(private apiKey: string, private listId: string) {}
  async subscribe(email: string, meta: SubscribeMeta): Promise<void> {
    if (!isValidEmail(email)) throw new Error('Invalid email');
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + this.apiKey
    };
    // Step 1: create contact (422 = already exists → treat as success)
    const contactRes = await fetch('https://api.nitrosend.com/v1/my/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, opt_in: meta.consent })
    });
    if (!contactRes.ok && contactRes.status !== 422) {
      throw new Error(`Nitrosend contact create error: ${contactRes.status} ${await contactRes.text()}`);
    }
    // Step 2: add to list
    const listRes = await fetch(`https://api.nitrosend.com/v1/my/lists/${this.listId}/contacts/bulk`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'add', emails: [email] })
    });
    if (!listRes.ok) {
      throw new Error(`Nitrosend list add error: ${listRes.status} ${await listRes.text()}`);
    }
  }
}

// Writes to two providers concurrently. The primary provider is authoritative —
// its failure surfaces as an error. The secondary is fire-and-forget; its failure
// is logged but does not fail the subscribe call.
export class DualProvider implements EmailProvider {
  constructor(private primary: EmailProvider, private secondary: EmailProvider) {}
  async subscribe(email: string, meta: SubscribeMeta): Promise<void> {
    await this.primary.subscribe(email, meta);
    this.secondary.subscribe(email, meta).catch(err =>
      console.error('[DualProvider] secondary write failed:', err)
    );
  }
}

export function getProvider(): EmailProvider {
  const which = (import.meta.env.EMAIL_PROVIDER ?? process.env.EMAIL_PROVIDER) as string;
  const apiKey = (import.meta.env.EMAIL_PROVIDER_API_KEY ?? process.env.EMAIL_PROVIDER_API_KEY ?? '') as string;
  const listId = (import.meta.env.EMAIL_LIST_ID ?? process.env.EMAIL_LIST_ID ?? '') as string;
  const resendKey = (import.meta.env.RESEND_API_KEY ?? process.env.RESEND_API_KEY ?? '') as string;
  const resendSeg = (import.meta.env.RESEND_SEGMENT_ID ?? process.env.RESEND_SEGMENT_ID ?? '') as string;
  const nitroKey = (import.meta.env.NITROSEND_API_KEY ?? process.env.NITROSEND_API_KEY ?? '') as string;
  const nitroList = (import.meta.env.NITROSEND_LIST_ID ?? process.env.NITROSEND_LIST_ID ?? '') as string;
  switch (which) {
    case 'kit':       return new KitProvider(apiKey, listId);
    case 'mailchimp': return new MailchimpProvider(apiKey, listId);
    case 'memory':    return new MemoryProvider();
    case 'resend':
      if (!resendKey) throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
      if (!resendSeg) throw new Error('RESEND_SEGMENT_ID is required when EMAIL_PROVIDER=resend');
      return new ResendProvider(resendKey, resendSeg);
    case 'nitrosend':
      if (!nitroKey)  throw new Error('NITROSEND_API_KEY is required when EMAIL_PROVIDER=nitrosend');
      if (!nitroList) throw new Error('NITROSEND_LIST_ID is required when EMAIL_PROVIDER=nitrosend');
      return new NitrosendProvider(nitroKey, nitroList);
    case 'dual': {
      if (!apiKey)    throw new Error('EMAIL_PROVIDER_API_KEY (Kit API key) is required when EMAIL_PROVIDER=dual');
      if (!listId)    throw new Error('EMAIL_LIST_ID (Kit form ID) is required when EMAIL_PROVIDER=dual');
      if (!nitroKey)  throw new Error('NITROSEND_API_KEY is required when EMAIL_PROVIDER=dual');
      if (!nitroList) throw new Error('NITROSEND_LIST_ID is required when EMAIL_PROVIDER=dual');
      return new DualProvider(
        new KitProvider(apiKey, listId),
        new NitrosendProvider(nitroKey, nitroList)
      );
    }
    default: throw new Error(`Unknown EMAIL_PROVIDER: ${which}`);
  }
}

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
    const res = await fetch(`https://api.kit.com/v4/forms/${this.formId}/subscribers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kit-Api-Key': this.apiKey
      },
      body: JSON.stringify({
        email_address: email,
        referrer: meta.referrer ?? meta.source,
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

export class LoopsProvider implements EmailProvider {
  constructor(private apiKey: string, private listId: string) {}
  async subscribe(email: string, meta: SubscribeMeta): Promise<void> {
    if (!isValidEmail(email)) throw new Error('Invalid email');
    const res = await fetch('https://app.loops.so/api/v1/contacts/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        email,
        mailingLists: { [this.listId]: true },
        source: meta.source,
        referrer: meta.referrer,
        utmSource: meta.utm_source,
        utmMedium: meta.utm_medium,
        utmCampaign: meta.utm_campaign,
        consentAt: meta.consent_timestamp
      })
    });
    if (!res.ok) throw new Error(`Loops API error: ${res.status} ${await res.text()}`);
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

export function getProvider(): EmailProvider {
  const which = (import.meta.env.EMAIL_PROVIDER ?? process.env.EMAIL_PROVIDER) as string;
  const apiKey = (import.meta.env.EMAIL_PROVIDER_API_KEY ?? process.env.EMAIL_PROVIDER_API_KEY ?? '') as string;
  const listId = (import.meta.env.EMAIL_LIST_ID ?? process.env.EMAIL_LIST_ID ?? '') as string;
  switch (which) {
    case 'kit':       return new KitProvider(apiKey, listId);
    case 'loops':     return new LoopsProvider(apiKey, listId);
    case 'mailchimp': return new MailchimpProvider(apiKey, listId);
    case 'memory':    return new MemoryProvider();
    default: throw new Error(`Unknown EMAIL_PROVIDER: ${which}`);
  }
}

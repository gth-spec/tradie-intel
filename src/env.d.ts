/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SECRET_KEY: string;
  readonly SUPABASE_PUBLISHABLE_KEY: string;
  readonly ANTHROPIC_API_KEY: string;
  readonly CRON_SECRET: string;
  readonly EMAIL_PROVIDER: 'kit' | 'loops' | 'mailchimp' | 'memory';
  readonly EMAIL_PROVIDER_API_KEY: string;
  readonly EMAIL_LIST_ID: string;
  readonly CLAUDE_MODEL: string;
  readonly FIRECRAWL_API_KEY: string;
  readonly APIFY_TOKEN: string;
  readonly AGENTMAIL_API_KEY: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }

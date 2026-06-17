import { PostHog } from 'posthog-node';

// Lazy singleton PostHog client for LLM observability ($ai_generation events).
// Returns null when POSTHOG_API_KEY is absent, so callers degrade gracefully to
// the plain Anthropic SDK. PostHog is additive here, never a hard dependency.
//
// import.meta.env is Astro-injected and undefined under a plain Node runtime
// (e.g. Trigger.dev), so optional-chain to let the process.env fallback fire -
// same pattern as claude.ts.
function envVar(name: string): string | undefined {
  return (import.meta as any).env?.[name] ?? process.env[name];
}

let client: PostHog | null = null;
let initialised = false;

export function getPosthog(): PostHog | null {
  if (initialised) return client;
  initialised = true;
  const key = envVar('POSTHOG_API_KEY');
  if (!key) return null;
  const host = envVar('POSTHOG_HOST') || 'https://us.i.posthog.com';
  client = new PostHog(key, { host });
  return client;
}

// Flush queued events. Critical in short-lived serverless / Trigger.dev runs
// where the batched client would otherwise drop events on process exit.
// Never let telemetry break the pipeline - swallow flush errors.
export async function flushPosthog(): Promise<void> {
  if (!client) return;
  try {
    await client.flush();
  } catch {
    /* telemetry is best-effort */
  }
}

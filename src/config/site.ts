export const SITE = {
  name: 'Tradie Intel',
  description: 'Daily AI-filtered news for Australian tradies.',
  url: 'https://tradieintel.com.au',
  niche: 'trades' as const,
  parent: {
    name: 'GrokoryAI',
    url: 'https://grokoryai.com'
  },
  email: {
    capturePlaceholder: 'your@email.com',
    ctaButton: 'Join the early list',
    ctaHeadline: 'Be first when the digest launches',
    // Honest framing: capturing emails only; daily email digest is v2.
    // Visitors get notified when the daily email goes live, plus practical
    // AI opportunities for Australian trade operators in the meantime.
    ctaSubhead: 'Daily trades intel - plus practical AI opportunities for Australian trade operators. We will email you when the daily digest launches.',
    consentText: 'I agree to receive emails from Tradie Intel and GrokoryAI. I can unsubscribe at any time.'
  }
};

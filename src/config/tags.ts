// Controlled tag vocabulary. Tags outside this list are normalised or dropped.

export const TRADE_CATEGORIES = ['plumbing', 'electrical', 'building', 'hvac', 'carpentry', 'painting', 'roofing'] as const;
export const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT'] as const;
export const THEMES = ['regulatory', 'licensing', 'safety', 'business', 'ai', 'weather', 'wages', 'tax', 'training'] as const;

export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  ...TRADE_CATEGORIES,
  ...STATES,
  ...THEMES
]);

// Normalisation map - common synonyms to canonical tag
export const TAG_ALIASES: Record<string, string> = {
  'queensland': 'QLD',
  'new south wales': 'NSW',
  'victoria': 'VIC',
  'western australia': 'WA',
  'south australia': 'SA',
  'tasmania': 'TAS',
  'plumber': 'plumbing',
  'plumbers': 'plumbing',
  'electrician': 'electrical',
  'electricians': 'electrical',
  'builder': 'building',
  'builders': 'building',
  'compliance': 'regulatory'
};

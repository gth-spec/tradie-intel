const MAX_LEN = 80;

export function titleToSlug(title: string, suffix?: string): string {
  let s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics (combining marks)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')      // strip punctuation
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .replace(/\s/g, '-');              // spaces to hyphens

  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN).replace(/-[^-]*$/, '');
  if (suffix) s = `${s}-${suffix}`;
  return s;
}

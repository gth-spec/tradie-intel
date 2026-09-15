// Splits plain text into text and link parts so a hand-edited https URL in
// feed copy (e.g. a key takeaway) renders as a clickable link.
// ponytail: only full https:// URLs are linked; bare domains stay text, so AI copy can't create stray links.
export type TextPart = { text: string; href?: string };

// Capturing group keeps URLs in the split output; last char excludes trailing punctuation.
const URL_SPLIT = /(https:\/\/[^\s<>"]*[^\s<>".,;:!?)])/;

export function linkify(text: string): TextPart[] {
  return text
    .split(URL_SPLIT)
    .filter(Boolean)
    .map(part =>
      part.startsWith('https://')
        ? { text: part.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, ''), href: part }
        : { text: part }
    );
}

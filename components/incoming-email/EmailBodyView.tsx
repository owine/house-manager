import { renderSanitizedEmailHtml } from '@/lib/incoming-email/render-html';

type Props = {
  bodyText: string | null;
  bodyHtml: string | null;
};

/**
 * Renders the email body, preferring sanitized HTML when present (falls back
 * to plaintext, then empty-state). Sanitization happens server-side via the
 * unified/hast pipeline; see `lib/incoming-email/render-html.tsx` for the
 * exact allowlist + image-hardening rules.
 *
 * The `prose` Tailwind classes give vendor mail readable defaults (link
 * underlines, list spacing, table styles) without us having to ship
 * email-specific styling. `prose-sm` keeps it sized for the detail card.
 */
export function EmailBodyView({ bodyText, bodyHtml }: Props) {
  // `renderSanitizedEmailHtml` returns null when the input is too large or the
  // pipeline throws. In either case, fall through to the plaintext branch
  // below rather than rendering an empty card.
  if (bodyHtml && bodyHtml.trim().length > 0) {
    const rendered = renderSanitizedEmailHtml(bodyHtml);
    if (rendered !== null) {
      return (
        <div className="prose prose-sm max-w-none break-words dark:prose-invert">{rendered}</div>
      );
    }
  }
  if (bodyText && bodyText.trim().length > 0) {
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
        {bodyText}
      </pre>
    );
  }
  return <p className="text-sm italic text-muted-foreground">(no body)</p>;
}

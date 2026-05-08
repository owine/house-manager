type Props = {
  bodyText: string | null;
  bodyHtml: string | null;
};

/**
 * Phase 1: plain-text rendering only.
 *
 * The DB stores both `bodyText` and `bodyHtml` so a future iteration can layer
 * sanitized HTML rendering on top without re-ingesting any messages. Adding an
 * HTML pipeline (rehype-parse + rehype-sanitize + hast-to-jsx) means new
 * dependencies, which the plan defers — vendor HTML emails rarely have content
 * that's not also in the plaintext multipart.
 *
 * If the email has neither text nor HTML, show an empty-state placeholder; if
 * it has only HTML, show a hint pointing the user at the raw row in the DB.
 */
export function EmailBodyView({ bodyText, bodyHtml }: Props) {
  if (bodyText && bodyText.trim().length > 0) {
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
        {bodyText}
      </pre>
    );
  }
  if (bodyHtml && bodyHtml.trim().length > 0) {
    return (
      <p className="text-sm italic text-muted-foreground">
        This email contains HTML-only content. Open the original email or any attachments for the
        full message.
      </p>
    );
  }
  return <p className="text-sm italic text-muted-foreground">(no body)</p>;
}

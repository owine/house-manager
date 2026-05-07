/**
 * Strip common Markdown syntax to plain text. Designed for short previews
 * (e.g., note card snippets) where rendering full Markdown isn't worth the
 * layout complexity but raw `**asterisks**` would be ugly. Not exhaustive —
 * tables, footnotes, HTML, fenced code blocks etc. are not handled. For
 * full rendering, use the Markdown component in lib/markdown.tsx.
 */
export function stripMarkdown(input: string): string {
  return (
    input
      // Images: ![alt](url) → alt. Must come before links so the leading `!` isn't orphaned.
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
      // Links: [text](url) → text.
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      // Bold: **text** or __text__ → text
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      // Italic: *text* or _text_ → text. Boundary uses Unicode whitespace + punctuation
      // so smart quotes, em dashes, and non-ASCII punctuation work as delimiters.
      // The `u` flag enables \p{P}.
      .replace(/(^|[\s\p{P}])\*([^*\n]+)\*(?=[\s\p{P}]|$)/gu, '$1$2')
      .replace(/(^|[\s\p{P}])_([^_\n]+)_(?=[\s\p{P}]|$)/gu, '$1$2')
      // Inline code: `code` → code
      .replace(/`([^`\n]+)`/g, '$1')
      // Headings: leading #, ##, ### etc. (must be at line start)
      .replace(/^#{1,6}\s+/gm, '')
      // Blockquotes: leading >
      .replace(/^>\s?/gm, '')
      // Unordered list markers at line start: - * +
      .replace(/^\s*[-*+]\s+/gm, '')
      // Ordered list markers: 1. 2. etc.
      .replace(/^\s*\d+\.\s+/gm, '')
      // Collapse 2+ blank lines into 1
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

// Explicit extended set of invisibles to strip from both ends. `.trim()` per
// ECMA-262 already handles Unicode WhiteSpace (incl. NBSP, BOM, U+2028/2029,
// U+3000), but NOT the zero-width format chars U+200B/200C/200D — those are
// category Cf, not WhiteSpace — so a body starting with a zero-width space
// (e.g. from a paste) would render as a visible empty-looking leading <p>.
// Listed exhaustively here for explicit control. Escape sequences (not literal
// chars) so formatters can't mangle the regex.
const INVISIBLE = '\\s\\u00A0\\u200B\\u200C\\u200D\\u2028\\u2029\\u3000\\uFEFF';
const INVISIBLE_EDGES = new RegExp(`^[${INVISIBLE}]+|[${INVISIBLE}]+$`, 'g');

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkBreaks, remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {children.replace(INVISIBLE_EDGES, '')}
      </ReactMarkdown>
    </div>
  );
}

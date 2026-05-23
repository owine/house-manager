import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

// Strip invisibles from both ends. `\s` covers Unicode WhiteSpace per ECMA-262
// (incl. NBSP, BOM, U+2028/2029, U+3000) — same set `.trim()` handles — so the
// load-bearing additions here are the zero-width format chars U+200B/200C/200D
// (Unicode category Cf, not WhiteSpace), which `.trim()` leaves in place; a
// body starting with one would render as a visible empty-looking leading <p>.
// The other explicit code points are belt-and-braces in case a future runtime
// narrows `\s`. Escape sequences (not literal chars) so formatters can't
// mangle the regex.
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

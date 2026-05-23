import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

// Strip ASCII whitespace AND common Unicode invisibles from both ends. Plain
// `.trim()` only handles ASCII, so a body starting with NBSP (e.g. from a
// paste) or a BOM would render as a visible empty-looking leading <p>. Escape
// sequences (not literal chars) so formatters can't mangle the regex.
// Covers: U+00A0 NBSP, U+200B–D zero-width space/joiner, U+FEFF BOM, U+3000
// ideographic space, U+2028/2029 line/paragraph separators.
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

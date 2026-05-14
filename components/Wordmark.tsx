// The owine offset-dot wordmark: lowercase word + accent-blue dot, baseline-
// aligned. The dot is the brand's single recurring motif — keep it on the
// surface anywhere the wordmark appears.
export function Wordmark({
  text = 'house manager',
  className = '',
}: {
  text?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-end leading-none tracking-[-0.03em] font-medium text-[color:var(--ink)] ${className}`}
    >
      {text}
      <span
        aria-hidden
        className="ml-[0.1em] mb-[0.16em] block size-[0.18em] rounded-full bg-[color:var(--accent)]"
      />
    </span>
  );
}

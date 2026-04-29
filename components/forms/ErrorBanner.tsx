export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        padding: '0.75rem 1rem',
        background: 'var(--danger-bg)',
        border: '1px solid var(--danger)',
        borderRadius: '4px',
        marginBottom: '1rem',
      }}
    >
      {message}
    </div>
  );
}

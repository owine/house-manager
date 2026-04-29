export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        padding: '0.75rem 1rem',
        background: '#fee',
        border: '1px solid #fbb',
        borderRadius: '4px',
        marginBottom: '1rem',
      }}
    >
      {message}
    </div>
  );
}

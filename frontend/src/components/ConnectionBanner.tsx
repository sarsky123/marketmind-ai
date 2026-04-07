interface Props {
  error: string | null;
  onDismiss: () => void;
}

export function ConnectionBanner({ error, onDismiss }: Props) {
  if (!error) return null;

  return (
    <div className="banner banner--error" role="alert">
      <span className="banner__text">{error}</span>
      <button type="button" className="banner__dismiss" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

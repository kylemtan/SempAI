import { useEffect } from 'react';

interface Props {
  onClose: () => void;
}

export default function FullAccessRequiredModal({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--compact"
        style={{ maxWidth: 420, textAlign: 'center' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Full Access required"
      >
        <div className="modal__header" style={{ justifyContent: 'flex-end' }}>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', paddingTop: 0 }}>
          <div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: 6 }}>Full Access required</h2>
            <p style={{ color: 'var(--text-secondary, #888)', fontSize: '0.9rem', lineHeight: 1.6 }}>
              Claude-assisted product matching (picking or verifying grocery matches with Claude instead of
              the built-in algorithm) is only available with <strong>Full Access</strong>. You're currently in{' '}
              <strong>Demo Mode</strong>, which still gets the full automatic matching algorithm — just not
              the Claude-assisted steps.
            </p>
          </div>

          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #888)' }}>
            Ask whoever shared this app with you for a Full Access link.
          </p>

          <button className="btn-primary" onClick={onClose} style={{ width: '100%' }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

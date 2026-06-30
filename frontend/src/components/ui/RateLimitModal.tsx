import { useEffect, useState } from 'react';

interface Props {
  resetAt: number; // epoch ms
  onClose: () => void;
}

function timeUntil(ms: number): string {
  const diff = Math.max(0, ms - Date.now());
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return 'less than a minute';
}

export default function RateLimitModal({ resetAt, onClose }: Props) {
  const [remaining, setRemaining] = useState(() => timeUntil(resetAt));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  useEffect(() => {
    const id = setInterval(() => setRemaining(timeUntil(resetAt)), 30_000);
    return () => clearInterval(id);
  }, [resetAt]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 420, textAlign: 'center' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Usage limit reached"
      >
        <div className="modal__header" style={{ justifyContent: 'flex-end' }}>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', paddingTop: 0 }}>
          <span style={{ fontSize: '2.5rem' }}>⚠️</span>

          <div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: 6 }}>Daily limit reached</h2>
            <p style={{ color: 'var(--text-secondary, #888)', fontSize: '0.9rem', lineHeight: 1.6 }}>
              SempAI is a demo that uses paid AI APIs. To keep it accessible without running up costs,
              generation is limited to <strong>2 requests per day</strong> per visitor.
            </p>
          </div>

          <div style={{
            width: '100%',
            padding: '14px 20px',
            background: 'var(--surface-2, rgba(0,0,0,0.08))',
            borderRadius: 10,
            fontSize: '0.9rem',
          }}>
            Resets in <strong>{remaining}</strong>
          </div>

          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #888)' }}>
            You can still browse your existing meal plan, favorites, shopping list, and all other features.
          </p>

          <button className="btn-primary" onClick={onClose} style={{ width: '100%' }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

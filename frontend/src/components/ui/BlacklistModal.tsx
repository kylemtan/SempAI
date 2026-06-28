import { useEffect } from 'react';
import { useMealPlanStore, BLACKLIST_TTL_MS, type BlacklistEntry } from '../../store/useMealPlanStore';

interface Props {
  onClose: () => void;
}

function daysRemaining(entry: BlacklistEntry): number {
  const expiresAt = entry.addedAt + BLACKLIST_TTL_MS;
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

export default function BlacklistModal({ onClose }: Props) {
  const { blacklist, removeFromBlacklist, clearBlacklist } = useMealPlanStore();

  const active = blacklist
    .filter((e) => Date.now() - e.addedAt < BLACKLIST_TTL_MS)
    .sort((a, b) => a.name.localeCompare(b.name));

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
        className="modal modal--blacklist"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Blacklisted recipes"
      >
        <div className="modal__header">
          <div className="modal__title-group">
            <h2 className="modal__title">Recent Recipes</h2>
            <p className="modal__subtitle">
              {active.length === 0
                ? 'No recipes are currently suppressed.'
                : `${active.length} recipe${active.length === 1 ? '' : 's'} will be excluded from new plans for up to 4 weeks.`}
            </p>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal__body">
          {active.length === 0 ? (
            <p className="blacklist-empty">
              Each time you generate a plan, its recipes are automatically added here so you get variety week to week.
            </p>
          ) : (
            <>
              <ul className="blacklist-list">
                {active.map((entry) => (
                  <li key={entry.id} className="blacklist-item">
                    <span className="blacklist-item__name">{entry.name}</span>
                    <span className="blacklist-item__expiry">
                      Expires in {daysRemaining(entry)}d
                    </span>
                    <button
                      className="blacklist-item__remove"
                      onClick={() => removeFromBlacklist(entry.id)}
                      aria-label={`Remove ${entry.name} from blacklist`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>

              <button
                className="blacklist-clear"
                onClick={() => { clearBlacklist(); onClose(); }}
              >
                Clear All
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

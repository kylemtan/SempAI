import { useEffect, useState } from 'react';
import HowItWorksModal from './HowItWorksModal';

interface Props {
  onClose: () => void;
  onRestartTour: () => void;
}

const FEATURES = [
  {
    title: 'Custom date range',
    body: 'Plan anywhere from 1 to 7 days starting on any date you choose.',
  },
  {
    title: 'Flexible meals per day',
    body: 'Choose 1–6 meals per day — breakfast, lunch, dinner, and snacks.',
  },
  {
    title: 'Dietary preferences',
    body: 'Set calorie, macro, and sodium targets. Filter by cuisine, allergens, and dietary lifestyle.',
  },
  {
    title: 'Time constraints',
    body: 'Cap prep and cook time per recipe so every meal fits your schedule.',
  },
  {
    title: 'Favorites & pinning',
    body: 'Star any recipe to save it. Pin favorites so they appear in your next generated plan.',
  },
  {
    title: 'Selective regeneration',
    body: 'Not happy with a meal? Select individual slots and regenerate just those.',
  },
  {
    title: 'Shopping list',
    body: 'Every plan comes with a combined shopping list and running total. Connect Kroger to add items straight to your cart, or manually review and swap products yourself.',
  },
  {
    title: 'Pantry',
    body: 'Log ingredients you already have. Pantry items are separated in the shopping list and auto-added when you cart items.',
  },
  {
    title: 'Export',
    body: 'Export your plan as a PDF (schedule, shopping list, or all recipes) or add meals to any calendar app via .ics.',
  },
  {
    title: 'Recent recipes',
    body: 'SempAI tracks recently generated recipes for 4 weeks so you always get variety.',
  },
];

const STEPS = [
  { n: '1', heading: 'Set your preferences', body: 'Open the sidebar and choose your date range, meals per day, cuisine, dietary needs, and time limits.' },
  { n: '2', heading: 'Generate', body: 'Click Generate Meal Plan. SempAI plans your week, searches real recipe sites, and writes full recipes in parallel.' },
  { n: '3', heading: 'Browse your plan', body: 'Click any meal card to open the full recipe — ingredients, steps, macros, and a link to the source site.' },
  { n: '4', heading: 'Refine', body: 'Star meals to save them as favorites. Select unwanted slots and click Regenerate to swap them out.' },
  { n: '5', heading: 'Shop', body: 'Open the Shopping List to review everything you need and see the total. Connect Kroger to add items to your cart in one click, or manually review items yourself.' },
];

export default function HelpModal({ onClose, onRestartTour }: Props) {
  const [showHowItWorks, setShowHowItWorks] = useState(false);

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
        className="help-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Help"
      >
        <div className="help-modal__header">
          <div>
            <h2 className="help-modal__title">SempAI</h2>
            <p className="help-modal__subtitle">Smart meal planning, powered by AI</p>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="help-modal__body">
          <section className="help-modal__section">
            <h3 className="help-modal__section-title">What you can do</h3>
            <div className="help-modal__features">
              {FEATURES.map((f, i) => (
                <div key={f.title} className="help-feature">
                  <span className="help-feature__num">{i + 1}</span>
                  <div>
                    <div className="help-feature__title">{f.title}</div>
                    <div className="help-feature__body">{f.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="help-modal__section">
            <h3 className="help-modal__section-title">How to get started</h3>
            <ol className="help-steps">
              {STEPS.map((s) => (
                <li key={s.n} className="help-step">
                  <span className="help-step__num">{s.n}</span>
                  <div>
                    <div className="help-step__heading">{s.heading}</div>
                    <div className="help-step__body">{s.body}</div>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <button className="help-modal__learn-more" onClick={() => setShowHowItWorks(true)}>
            How does recipe generation and shopping matching actually work? →
          </button>
        </div>

        <div className="help-modal__footer">
          <button className="help-modal__restart-tour" onClick={onRestartTour}>
            ↻ Restart tutorial
          </button>
          <button className="btn-primary" onClick={onClose}>Get started</button>
        </div>
      </div>
      {showHowItWorks && <HowItWorksModal onClose={() => setShowHowItWorks(false)} />}
    </div>
  );
}

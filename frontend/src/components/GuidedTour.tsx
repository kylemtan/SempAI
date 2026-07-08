import { useEffect, useRef, useState } from 'react';

interface Step {
  selector: string | null;
  title: string;
  body: string;
  needsSidebar?: boolean;
  scrollContainer?: string;
  scrollTo?: 'top' | 'bottom';
}

const STEPS: Step[] = [
  {
    selector: null,
    title: 'Welcome to SempAI',
    body: 'Before you dive in, here’s a quick tour of where everything lives — it only takes a minute.',
  },
  {
    selector: '[data-tour="sidebar"]',
    title: 'Set your preferences',
    body: 'Date range, meals per day, cuisine, dietary needs, and time limits all live here.',
    needsSidebar: true,
    scrollContainer: '.sidebar__scroll',
    scrollTo: 'top',
  },
  {
    selector: '[data-tour="generate-btn"]',
    title: 'Generate your plan',
    body: 'SempAI plans your week, searches real recipe sites, and writes full recipes.',
    needsSidebar: true,
    scrollContainer: '.sidebar__scroll',
    scrollTo: 'bottom',
  },
  {
    selector: '[data-tour="main-panel"]',
    title: 'Browse & refine',
    body: 'Once it’s ready, click any meal to open the full recipe. Star ones you love, or select a meal and hit the ↺ icon to swap it for something else.',
  },
  {
    selector: '[data-tour="pantry-btn"]',
    title: 'Track what you already have',
    body: 'Log ingredients sitting in your kitchen — they’re set aside in your shopping list automatically.',
  },
  {
    selector: '[data-tour="favorites-btn"]',
    title: 'Save recipes you love',
    body: 'Starred recipes are saved here. Pin any of them so they’re reused the next time you generate a plan.',
  },
  {
    selector: '[data-tour="blacklist-btn"]',
    title: 'Keep things varied',
    body: 'SempAI won’t repeat a recipe you’ve had in the last 4 weeks — manage that list here.',
  },
  {
    selector: '[data-tour="shopping-btn"]',
    title: 'Shop for the week',
    body: 'Once you have a plan, the Shopping List button up here has one combined list for everything you need — connect Kroger to add it all to your cart in one click.',
  },
  {
    selector: '[data-tour="help-btn"]',
    title: 'Come back anytime',
    body: 'Click here to replay this tour or see the full feature list whenever you need a reminder.',
  },
];

const REAL_STEP_COUNT = STEPS.filter((s) => s.selector !== null).length;

interface Props {
  onFinish: () => void;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onCloseSidebar: () => void;
}

interface Rect { top: number; left: number; width: number; height: number; }

type Placement = 'below' | 'above' | 'right' | 'left';

export default function GuidedTour({ onFinish, sidebarOpen, onOpenSidebar, onCloseSidebar }: Props) {
  const [current, setCurrent] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const wasSidebarForced = useRef(false);
  const step = STEPS[current];

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Force the off-canvas sidebar open/closed on mobile for the steps that need it.
  useEffect(() => {
    const isMobile = window.innerWidth <= 768;
    if (!isMobile) return;
    if (step.needsSidebar && !sidebarOpen) {
      wasSidebarForced.current = true;
      onOpenSidebar();
    } else if (!step.needsSidebar && wasSidebarForced.current) {
      wasSidebarForced.current = false;
      onCloseSidebar();
    }
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!step.selector) { setRect(null); return; }

    function place() {
      if (!step.selector) return;
      const el = document.querySelector(step.selector);
      if (!el) { setRect(null); return; }

      if (step.scrollContainer && step.scrollTo) {
        const container = document.querySelector(step.scrollContainer);
        if (container) {
          container.scrollTop = step.scrollTo === 'top' ? 0 : container.scrollHeight;
        }
      } else {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }

      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    }

    // The sidebar drawer animates open/closed (0.28s) on mobile — wait it out
    // before measuring, otherwise we'd spotlight its resting position.
    const isMobile = window.innerWidth <= 768;
    const delay = isMobile && step.needsSidebar ? 320 : 0;
    const t = setTimeout(place, delay);

    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [current, sidebarOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  function cleanupSidebar() {
    if (wasSidebarForced.current) {
      wasSidebarForced.current = false;
      onCloseSidebar();
    }
  }

  function next() {
    if (current === STEPS.length - 1) { cleanupSidebar(); onFinish(); return; }
    setCurrent((i) => i + 1);
  }

  function back() {
    if (current === 0) return;
    setCurrent((i) => i - 1);
  }

  function skip() {
    cleanupSidebar();
    onFinish();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') skip();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') back();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const dots = STEPS.filter((s) => s.selector !== null);
  const realStepIndex = STEPS.slice(0, current + 1).filter((s) => s.selector !== null).length - 1;

  const footer = (
    <div className="tour-tooltip__footer">
      <div className="tour-tooltip__dots">
        {dots.map((_, i) => (
          <span key={i} className={i === realStepIndex ? 'is-current' : ''} />
        ))}
      </div>
      <div className="tour-tooltip__btns">
        {current > 0 && (
          <button className="tour-btn tour-btn--ghost" onClick={back}>Back</button>
        )}
        <button className="tour-btn tour-btn--primary" onClick={next}>
          {current === 0 ? 'Let’s go' : current === STEPS.length - 1 ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  );

  // Welcome screen, or a step whose target isn't in the DOM yet (e.g. "Shop for
  // the week" before a plan exists) — no target to spotlight, so use a centered card.
  if (!step.selector || !rect) {
    return (
      <div className="tour-scrim">
        <div className="tour-dim" />
        <button className="tour-skip" onClick={skip}>Skip tour ✕</button>
        <div className="tour-tooltip tour-tooltip--welcome">
          {step.selector && (
            <span className="tour-tooltip__eyebrow">Step {realStepIndex + 1} of {REAL_STEP_COUNT}</span>
          )}
          {!step.selector && <span className="tour-tooltip__eyebrow">Quick tour</span>}
          <h3 className="tour-tooltip__title">{step.title}</h3>
          <p className="tour-tooltip__body">{step.body}</p>
          {footer}
        </div>
      </div>
    );
  }

  const pad = 6;
  const spotlightStyle = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };

  const ttWidth = 270;
  const gap = 14;
  const isDominant = rect.width > window.innerWidth * 0.45 && rect.height > window.innerHeight * 0.45;
  const isTall = !isDominant && rect.height > window.innerHeight * 0.5;

  let placement: Placement;
  let ttTop: number;
  let ttLeft: number;

  if (isDominant) {
    // Too big to point at from outside its own edges, and we want the tooltip to
    // sit off to the side (over the dimmed sidebar) so the highlighted region itself
    // stays completely unobstructed.
    placement = 'left';
    ttLeft = rect.left - ttWidth - gap;
    ttTop = Math.max(90, Math.min(rect.top + rect.height / 2, window.innerHeight - 90));
  } else if (isTall) {
    const spaceRight = window.innerWidth - (rect.left + rect.width);
    placement = spaceRight >= ttWidth + gap + 12 ? 'right' : 'left';
    ttLeft = placement === 'right' ? rect.left + rect.width + gap : rect.left - ttWidth - gap;
    ttTop = Math.max(90, Math.min(rect.top + rect.height / 2, window.innerHeight - 90));
  } else {
    const spaceBelow = window.innerHeight - (rect.top + rect.height);
    placement = spaceBelow >= 190 ? 'below' : 'above';
    ttTop = placement === 'below' ? rect.top + rect.height + gap : rect.top - gap;
    ttLeft = rect.left + rect.width / 2 - ttWidth / 2;
    ttLeft = Math.max(12, Math.min(ttLeft, window.innerWidth - ttWidth - 12));
  }

  const transforms: Record<Placement, string> = {
    below: 'none',
    above: 'translateY(-100%)',
    right: 'translateY(-50%)',
    left: 'translateY(-50%)',
  };

  return (
    <div className="tour-scrim">
      <button className="tour-skip" onClick={skip}>Skip tour ✕</button>
      <div className="tour-spotlight" style={spotlightStyle} />
      <div
        className="tour-tooltip"
        style={{ top: ttTop, left: ttLeft, transform: transforms[placement] }}
      >
        <span className="tour-tooltip__eyebrow">Step {realStepIndex + 1} of {REAL_STEP_COUNT}</span>
        <h3 className="tour-tooltip__title">{step.title}</h3>
        <p className="tour-tooltip__body">{step.body}</p>
        {footer}
      </div>
    </div>
  );
}

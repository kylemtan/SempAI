import { useEffect, useState } from 'react';
import { useThemeStore } from './store/useThemeStore';
import { useKrogerStore } from './store/useKrogerStore';
import { useMealPlanStore } from './store/useMealPlanStore';
import ThemeToggle from './components/ThemeToggle';
import Sidebar from './components/Sidebar';
import MealPlanView from './components/MealPlanView';
import BlacklistModal from './components/ui/BlacklistModal';
import FavoritesModal from './components/ui/FavoritesModal';
import PantryModal from './components/ui/PantryModal';
import HelpModal from './components/ui/HelpModal';

export default function App() {
  const theme = useThemeStore((s) => s.theme);
  const initializeKroger = useKrogerStore((s) => s.initialize);
  const { mealPlan } = useMealPlanStore();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showFavorites, setShowFavorites] = useState(false);
  const [showBlacklist, setShowBlacklist] = useState(false);
  const [showPantry, setShowPantry] = useState(false);
  const [showHelp, setShowHelp] = useState(() => {
    const seen = localStorage.getItem('sempai-help-seen');
    if (!seen) { localStorage.setItem('sempai-help-seen', '1'); return true; }
    return false;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('kroger_connected') || params.has('kroger_error')) {
      if (window.opener && !window.opener.closed) {
        // This is the OAuth callback tab — notify the opener and close
        window.opener.postMessage(
          params.has('kroger_connected') ? 'kroger_connected' : 'kroger_error',
          window.location.origin
        );
        window.close();
        return;
      }
      // Fallback: same-tab flow (opener not available)
      window.history.replaceState({}, '', window.location.pathname);
    }
    initializeKroger();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data === 'kroger_connected') initializeKroger();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [initializeKroger]);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 769px)');
    const handler = (e: MediaQueryListEvent) => { if (e.matches) setSidebarOpen(false); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__left">
          <button
            className="app-header__hamburger"
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            <span /><span /><span />
          </button>
          <div className="app-header__wordmark">
            <span className="app-header__logo">SempAI</span>
            <span className="app-header__tagline">Smart and easy meal planning using AI, all in one place</span>
          </div>
        </div>

        <div className="app-header__actions">
          <button
            className="header-action-btn"
            onClick={() => setShowPantry(true)}
          >
            Pantry
          </button>
          <button
            className="header-action-btn"
            onClick={() => setShowFavorites(true)}
          >
            Favorites
          </button>
          <button
            className="header-action-btn"
            onClick={() => setShowBlacklist(true)}
          >
            Recent Recipes
          </button>
          <button
            className="header-action-btn header-action-btn--help"
            onClick={() => setShowHelp(true)}
            aria-label="Help"
          >
            ?
          </button>
          <ThemeToggle />
        </div>
      </header>

      <div className="app-body">
        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <MealPlanView />
      </div>

      {showPantry && <PantryModal onClose={() => setShowPantry(false)} />}
      {showFavorites && <FavoritesModal onClose={() => setShowFavorites(false)} />}
      {showBlacklist && <BlacklistModal onClose={() => setShowBlacklist(false)} />}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}

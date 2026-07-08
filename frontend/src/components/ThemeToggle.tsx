import { useThemeStore } from '../store/useThemeStore';

export default function ThemeToggle() {
  const { theme, toggleTheme } = useThemeStore();
  return (
    <button
      className={`theme-toggle theme-toggle--${theme}`}
      onClick={toggleTheme}
      aria-label="Toggle theme"
    >
      {theme === 'light' ? '☾' : '☀'} {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
    </button>
  );
}

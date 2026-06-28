import { useThemeStore } from '../store/useThemeStore';

export default function ThemeToggle() {
  const { theme, toggleTheme } = useThemeStore();
  return (
    <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
      {theme === 'light' ? '☽' : '○'} {theme === 'light' ? 'Dark' : 'Light'}
    </button>
  );
}

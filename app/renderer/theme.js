/* ── theme.js — theme, accent, density ─────────────────────────── */

export const ACCENT_COLORS = {
  red:    ['#e94560','#ff6b81'],
  orange: ['#f0952c','#f5b84a'],
  amber:  ['#f5a623','#ffc55a'],
  green:  ['#3ddc84','#6feea6'],
  teal:   ['#2dd4bf','#5eead4'],
  blue:   ['#4a9eff','#76baff'],
  indigo: ['#818cf8','#a5b4fc'],
  purple: ['#a855f7','#c084fc'],
  pink:   ['#ec4899','#f472b6'],
};

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? '' : theme;
}

export function applyAccent(id) {
  const root = document.documentElement;
  if (!id || id === 'default') {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent2');
  } else {
    const [a, a2] = ACCENT_COLORS[id] ?? [];
    if (a)  root.style.setProperty('--accent',  a);
    if (a2) root.style.setProperty('--accent2', a2);
  }
}

export function applyDensity(density) {
  document.documentElement.classList.toggle('density-compact', density === 'compact');
}

export function applyGlassTheme({ hue, sat, opacity, accentHue } = {}) {
  const root = document.documentElement;
  if (hue      != null) root.style.setProperty('--base-hue',      hue);
  if (sat      != null) root.style.setProperty('--base-sat',      `${sat}%`);
  if (opacity  != null) root.style.setProperty('--glass-opacity', opacity);
  if (accentHue != null) {
    root.style.setProperty('--accent-hue', accentHue);
    // Clear any inline preset overrides so the hue variable wins
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent2');
  }
}

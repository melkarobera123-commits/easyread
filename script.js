/* EasyRead interface polish: theme, text size, reading progress, opening demo.
   Loaded in <head> so the saved theme is applied before the page paints. */
(() => {
  const root = document.documentElement;
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }
  };

  root.dataset.theme = store.get('er-theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);

    // Footer copyright year
    const year = $('copyright-year'); if (year) year.textContent = String(new Date().getFullYear());

    // Light / sepia / dark theme
    const THEMES = ['light', 'sepia', 'dark'];
    const NAMES = { light: 'Light mode', sepia: 'Sepia mode', dark: 'Dark mode' };
    const nextTheme = () => THEMES[(THEMES.indexOf(root.dataset.theme) + 1) % THEMES.length];
    if (!THEMES.includes(root.dataset.theme)) root.dataset.theme = 'light';
    const updateThemeLabel = () => {
      const next = nextTheme();
      const label = $('theme-label');
      if (label) label.textContent = NAMES[next];
      const button = $('theme');
      if (button) button.setAttribute('aria-label', 'Switch to ' + NAMES[next].toLowerCase());
      document.querySelectorAll('[data-easyread-theme-toggle]').forEach(control => {
        control.setAttribute('aria-label', 'Current theme: ' + NAMES[root.dataset.theme] + '. Switch to ' + NAMES[next].toLowerCase());
        control.title = 'Switch to ' + NAMES[next].toLowerCase();
        control.textContent = root.dataset.theme === 'sepia' ? '◒' : root.dataset.theme === 'dark' ? '☾' : '◐';
      });
    };
    window.setEasyReadTheme = theme => {
      if (!THEMES.includes(theme)) return;
      root.dataset.theme = theme;
      store.set('er-theme', theme);
      updateThemeLabel();
    };
    window.cycleEasyReadTheme = () => window.setEasyReadTheme(nextTheme());
    $('theme')?.addEventListener('click', window.cycleEasyReadTheme);
    updateThemeLabel();

    // Reading text size
    let size = parseFloat(store.get('er-size')) || 1.25;
    const applySize = () => root.style.setProperty('--reader-fs', size + 'rem');
    const step = d => { size = Math.min(2, Math.max(1, size + d)); applySize(); store.set('er-size', size); };
    applySize();
    $('smaller').addEventListener('click', () => step(-0.125));
    $('larger').addEventListener('click', () => step(0.125));

    // Reading progress line across the top
    const meter = $('meter'), wrap = $('reader-wrap'), article = $('reader');
    const tick = () => {
      if (wrap.hidden) { meter.style.transform = 'scaleX(0)'; return; }
      const r = article.getBoundingClientRect();
      const span = Math.max(r.height - innerHeight * 0.6, 1);
      meter.style.transform = `scaleX(${Math.min(1, Math.max(0, -r.top / span))})`;
    };
    addEventListener('scroll', tick, { passive: true });
    addEventListener('resize', tick);

    // One opening moment: the sample sentence shows a definition by itself.
    let touched = false;
    addEventListener('pointerdown', () => { touched = true; }, { once: true });
    addEventListener('load', () => {
      if (matchMedia('(max-width: 640px)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const text = document.createTreeWalker(document.querySelector('.stack .readable'), NodeFilter.SHOW_TEXT).nextNode();
      const i = text ? text.data.indexOf('ominous') : -1;
      if (i < 0 || typeof showWord !== 'function') return;
      setTimeout(() => {
        if (touched) return;
        const range = document.createRange();
        range.setStart(text, i); range.setEnd(text, i + 7);
        showWord({ word: 'ominous', range });
      }, 1300);
    });
  });
})();

// Load web fonts without blocking the first paint (important on slow connections).
(() => { const css = document.getElementById('font-css'); if (css) { css.media = 'all'; } })();

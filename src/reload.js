// Ludora neu laden (Knopf neben „Sortieren“, F5, Strg+R): die Seite lädt neu und liest dabei die
// Bibliothek frisch ein. Beim Neuladen läuft die Logo-Animation im Fenster (index.html), nicht als eigenes Fenster.
export function reloadApp() {
  try { sessionStorage.setItem('ludora.reload', '1'); } catch { /* egal */ }
  window.location.reload();
}

/** Browser-Kontextmenü (mit „Neu laden“) aus, F5/Strg+R über reloadApp() */
export function installReloadGuards() {
  if (import.meta.env.DEV) return; // Testversion: Kontextmenü zum Untersuchen behalten
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
      e.preventDefault();
      reloadApp();
    }
  });
}

/** Logo-Animation nach dem Neuladen ausblenden, sobald die Oberfläche steht (frühestens nach der Animation) */
export function hideReloadSplash() {
  const el = document.getElementById('reload-splash');
  if (!el) return;
  const wait = Math.max(0, 1700 - (performance.now() - (window.__reloadT || 0)));
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, wait);
}

import React, { useEffect, useState } from 'react';
import { t } from '../i18n.js';

// Fensterknöpfe (–, □, ✕) für die Rust-Version unter Windows/Linux. Electron zeichnet sie selbst
// (titleBarOverlay), Tauri ohne Systemrahmen nicht – darum hier im Stil der Leiste.
export default function WindowControls() {
  const [win, setWin] = useState(null);
  const [max, setMax] = useState(false);
  useEffect(() => {
    let stop = null;
    let alive = true;
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (!alive) return;
      const w = getCurrentWindow();
      setWin(w);
      const sync = () => w.isMaximized().then(setMax).catch(() => {});
      sync();
      w.onResized(sync).then((fn) => { if (alive) stop = fn; else fn(); });
    }).catch(() => {});
    return () => { alive = false; stop?.(); };
  }, []);
  if (!win) return null;
  return (
    <div className="win-controls">
      <button className="wc-btn" onClick={() => win.minimize()} aria-label={t("Minimieren")} title={t("Minimieren")}>
        <svg viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
      </button>
      <button className="wc-btn" onClick={() => win.toggleMaximize()} aria-label={max ? t("Verkleinern") : t("Maximieren")} title={max ? t("Verkleinern") : t("Maximieren")}>
        {max
          ? <svg viewBox="0 0 10 10"><path d="M3 1h6v6M1 3h6v6H1z" /></svg>
          : <svg viewBox="0 0 10 10"><path d="M1 1h8v8H1z" /></svg>}
      </button>
      <button className="wc-btn close" onClick={() => win.close()} aria-label={t("Schließen")} title={t("Schließen")}>
        <svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" /></svg>
      </button>
    </div>
  );
}

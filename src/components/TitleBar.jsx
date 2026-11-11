import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { StoreIcon } from './bits.jsx';
import logoUrl from '../assets/logo.svg';
import { t } from '../i18n.js';
import UpdateDialog from './UpdateDialog.jsx';
import WindowControls from './WindowControls.jsx';

// Fensterleiste ganz oben (wie bei Steam): Logo, Menü „Ludora“, die Bereiche und rechts das Ludora-Konto.
// Gezogen wird über data-tauri-drag-region. Windows/Linux: eigene Fensterknöpfe (–, □, ✕) rechts;
// macOS: die Ampel-Knöpfe sitzen links in der Leiste.
const platform = api.platform || 'demo';
const ownControls = api.runtime === 'tauri' && platform !== 'darwin';

const LibraryIcon = () => (
  <svg viewBox="0 0 24 24"><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="16" rx="1" /><path d="m17.5 5.2 3 .8-3.6 14-3-.8" /></svg>
);

/** Menüleiste: Klick öffnet, solange eins offen ist, wechselt Überfahren das Menü; Esc/Klick daneben schließt */
function MenuBar({ menus }) {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (open == null) return undefined;
    const down = (e) => { if (!ref.current?.contains(e.target)) setOpen(null); };
    const key = (e) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', () => setOpen(null), { once: true });
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <div className="tb-menus" ref={ref}>
      {menus.map((m, i) => (
        <div key={m.label} className="tb-menu">
          <button className={`tb-menu-btn ${open === i ? 'on' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); setOpen(open === i ? null : i); }}
            onMouseEnter={() => { if (open != null) setOpen(i); }}>
            {m.label}
          </button>
          {open === i && (
            <div className="tb-dropdown" role="menu">
              {m.items.filter(Boolean).map((it, k) => (it === '-'
                ? <div key={`sep${k}`} className="tb-dd-sep" />
                : (
                  <button key={it.label} role="menuitem" className="tb-dd-item" disabled={it.disabled}
                    onClick={() => { setOpen(null); it.onClick?.(); }}>
                    {it.icon && <span className="tb-dd-icon">{it.icon}</span>}
                    <span className="tb-dd-label">{it.label}</span>
                    {it.hint && <span className="tb-dd-hint">{it.hint}</span>}
                  </button>
                )))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function TitleBar({ page, onLibrary, onShop, onSettings, onRefresh, onAccount, notify }) {
  const [hub, setHub] = useState(null);
  useEffect(() => {
    if (!api.hub?.get) return undefined;
    api.hub.get().then(setHub).catch(() => {});
    return api.hub.onUpdate?.(setHub);
  }, []);
  const signedIn = hub?.status === 'signedIn';

  // Update aus GitHub verfügbar? -> grünes Download-Symbol neben dem Konto
  const [update, setUpdate] = useState(null);
  useEffect(() => {
    if (!api.update?.get) return undefined;
    api.update.get().then(setUpdate).catch(() => {});
    return api.update.onChange(setUpdate);
  }, []);
  const [updateOpen, setUpdateOpen] = useState(false);
  useEffect(() => api.update?.onOpen?.(() => setUpdateOpen(true)), []); // Klick auf die Benachrichtigung
  const installUpdate = async () => {
    const r = await api.update.install();
    if (!r?.ok || r.page || r.manual) setUpdateOpen(false);
    if (r?.page) notify(t("Die Release-Seite ist geöffnet."));
    else if (r?.manual) notify(t("Das Update ist geladen – bitte im geöffneten Fenster installieren."));
    else if (r && !r.ok && !r.cancelled && r.error) notify(t("Update fehlgeschlagen: {0}", [r.error]), 'error');
  };
  const busy = update?.status === 'downloading' || update?.status === 'installing';
  const name = hub?.user?.display_name || hub?.user?.username;

  const about = async () => {
    const i = await api.app?.info?.().catch(() => null);
    notify(i ? `Ludora ${i.version} – the Client for all Game Clients` : 'Ludora');
  };

  const menus = [
    {
      label: 'Ludora',
      items: [
        { label: signedIn ? t("Ludora-Konto verwalten …") : t("Beim Ludora-Konto anmelden …"), onClick: onAccount },
        signedIn && { label: t("Abmelden"), onClick: () => api.hub.logout().then(() => notify(t("Vom Ludora-Konto abgemeldet"))) },
        '-',
        { label: t("Bibliothek neu einlesen"), onClick: onRefresh },
        { label: t("Einstellungen"), onClick: onSettings },
        '-',
        { label: t("Über Ludora"), onClick: about },
        { label: t("Beenden"), onClick: () => (api.app?.quit ? api.app.quit() : window.close()) }
      ]
    }
  ];

  return (
    (<header className={`titlebar ${platform} ${ownControls ? 'own-controls' : ''}`} data-tauri-drag-region>
      <div className="tb-brand">
        <img src={logoUrl} alt="" draggable={false} />
        <MenuBar menus={menus} />
      </div>
      <nav className="tb-nav">
        <button className={page === 'library' ? 'on' : ''} onClick={onLibrary}><LibraryIcon /><span>{t("Bibliothek")}</span></button>
        <button className={page === 'shop' ? 'on' : ''} onClick={onShop}><StoreIcon /><span>{t("Shop")}</span></button>
      </nav>
      <div className="tb-drag" data-tauri-drag-region />
      {(update?.status === 'available' || busy) && (
        <button className={`tb-update ${busy ? 'busy' : ''}`} onClick={() => setUpdateOpen(true)}
          title={busy
            ? (update.status === 'installing' ? t("Update wird installiert …") : t("Update wird geladen … {0} %", [Math.round((update.progress || 0) * 100)]))
            : t("Ludora {0} ist da – klicken zum Aktualisieren", [update.latest])}
          aria-label={t("Update installieren")}>
          <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
          {busy && <span className="tb-update-pct">{update.status === 'installing' ? '…' : `${Math.round((update.progress || 0) * 100)}%`}</span>}
        </button>
      )}
      {updateOpen && update && <UpdateDialog update={update} onConfirm={installUpdate} onClose={() => setUpdateOpen(false)} />}
      <button className="tb-settings" onClick={onSettings} title={t("Einstellungen")} aria-label={t("Einstellungen")}>
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
      <button className={`tb-account ${signedIn ? 'on' : ''}`} onClick={onAccount}
        title={signedIn ? t("Angemeldet als {0} – Ludora-Konto verwalten", [name]) : t("Beim Ludora-Konto anmelden")}>
        <span className="tb-avatar">{signedIn ? String(name || '?')[0].toUpperCase() : '?'}</span>
        <span className="tb-name">{signedIn ? name : t("Anmelden")}</span>
      </button>
      {ownControls && <WindowControls />}
    </header>)
  );
}

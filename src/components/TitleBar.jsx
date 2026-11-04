import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { StoreIcon } from './bits.jsx';
import logoUrl from '../assets/logo.svg';
import { t } from '../i18n.js';

// Fensterleiste ganz oben (wie bei Steam): Logo, Menü „Ludora“, die Bereiche und rechts das Ludora-Konto. Die Leiste zieht das Fenster; Knöpfe sind davon ausgenommen.
// Unter Windows zeichnet Electron rechts die echten Fensterknöpfe (–, □, ✕) darüber.
const platform = api.platform || 'demo';

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
    (<header className={`titlebar ${platform}`}>
      <div className="tb-brand">
        <img src={logoUrl} alt="" draggable={false} />
        <MenuBar menus={menus} />
      </div>
      <nav className="tb-nav">
        <button className={page === 'library' ? 'on' : ''} onClick={onLibrary}><LibraryIcon /><span>{t("Bibliothek")}</span></button>
        <button className={page === 'shop' ? 'on' : ''} onClick={onShop}><StoreIcon /><span>{t("Shop")}</span></button>
      </nav>
      <div className="tb-drag" />
      <button className={`tb-account ${signedIn ? 'on' : ''}`} onClick={onAccount}
        title={signedIn ? t("Angemeldet als {0} – Ludora-Konto verwalten", [name]) : t("Beim Ludora-Konto anmelden")}>
        <span className="tb-avatar">{signedIn ? String(name || '?')[0].toUpperCase() : '?'}</span>
        <span className="tb-name">{signedIn ? name : t("Anmelden")}</span>
      </button>
    </header>)
  );
}

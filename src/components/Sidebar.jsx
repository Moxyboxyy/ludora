import React, { useState } from 'react';
import { OpenIcon, LauncherLogo, DownloadIcon, StarIcon } from './bits.jsx';
import { t } from '../i18n.js';

function loadPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* egal */ }
}

/** Seitenleiste umschalten: breit <-> nur Symbole */
const CollapseIcon = ({ collapsed }) => (
  <svg viewBox="0 0 24 24">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M9 4.5v15" />
    <path d={collapsed ? 'm13 10 2.5 2-2.5 2' : 'm15.5 10-2.5 2 2.5 2'} />
  </svg>
);

/** Aufklappbare Überschrift (z. B. "Launcher") */
function Section({ id, title, count, open, onToggle, collapsed, children }) {
  if (collapsed) {
    // Schmale Leiste: nur eine Trennlinie, Inhalt immer sichtbar
    return <><div className="nav-sep" title={title} />{children}</>;
  }
  return (
    <>
      <button className="nav-heading toggle" onClick={onToggle} aria-expanded={open} aria-controls={`sec-${id}`}>
        <span className={`chev ${open ? 'open' : ''}`}>▸</span>
        <span className="label">{title}</span>
        {!open && count > 0 && <span className="badge">{count}</span>}
      </button>
      {open && <div id={`sec-${id}`} className="nav-section">{children}</div>}
    </>
  );
}

export default function Sidebar({
  providers, counts, active, onSelect, onAdd, onOpenLauncher,
  downloads, onDownloads, collapsed, onToggleCollapsed
}) {
  // Nur eingeschaltete Launcher anzeigen (Einstellungen -> Launcher)
  const enabled = providers.filter((p) => p.enabled !== false);
  const withGames = enabled.filter((p) => p.count > 0);
  const empty = enabled.filter((p) => p.count === 0 && p.id !== 'manual');

  const [openLaunchers, setOpenLaunchers] = useState(() => loadPref('sec.launchers', true));
  const [openEmpty, setOpenEmpty] = useState(() => loadPref('sec.empty', true));
  const toggle = (setter, key, cur) => () => { setter(!cur); savePref(key, !cur); };

  // In der schmalen Leiste erklärt der Tooltip, was hinter dem Symbol steckt
  const tip = (text, n) => (collapsed ? `${text}${n ? ` (${n})` : ''}` : undefined);

  return (
    (<aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="brand">
        {!collapsed && <span className="brand-name">{t("Bibliothek")}</span>}
        <button className="collapse-btn" onClick={onToggleCollapsed}
          title={collapsed ? t("Seitenleiste ausklappen") : t("Seitenleiste einklappen (nur Symbole)")}>
          <CollapseIcon collapsed={collapsed} />
        </button>
      </div>
      <nav>
        <button className={`nav-item ${active === 'all' ? 'active' : ''}`} onClick={() => onSelect('all')} title={tip(t("Alle Spiele"), counts.all)}>
          <span className="nav-icon"><span className="dot all" /></span>
          <span className="label">{t("Alle Spiele")}</span>
          <span className="badge">{counts.all || 0}</span>
        </button>
        <button className={`nav-item fav-nav ${active === 'favorites' ? 'active' : ''}`} onClick={() => onSelect('favorites')} title={tip(t("Favoriten"), counts.favorites)}>
          <span className="nav-icon"><StarIcon filled /></span>
          <span className="label">{t("Favoriten")}</span>
          <span className="badge">{counts.favorites || 0}</span>
        </button>

        <Section id="launchers" title="Launcher" count={withGames.length} open={openLaunchers}
          onToggle={toggle(setOpenLaunchers, 'sec.launchers', openLaunchers)} collapsed={collapsed}>
          {withGames.map((p) => (
            <div key={p.id} className="nav-row">
              <button
                className={`nav-item ${active === p.id ? 'active' : ''}`}
                onClick={() => onSelect(p.id)}
                title={collapsed ? tip(p.name, counts[p.id]) : p.error ? t("Hinweis: {0}", [p.error]) : undefined}
              >
                <span className="nav-icon"><LauncherLogo provider={p} /></span>
                <span className="label">{p.name}</span>
                {p.error && <span className="warn">!</span>}
                <span className="badge">{counts[p.id] || 0}</span>
              </button>
              {p.hasClient && !collapsed && (
                <button className="nav-open" onClick={() => onOpenLauncher(p.id, 'client')} title={t("{0} öffnen", [p.name])}>
                  <OpenIcon />
                </button>
              )}
            </div>
          ))}
        </Section>

        {empty.length > 0 && (
          <Section id="empty" title={t("Nicht installiert")} count={empty.length} open={openEmpty}
            onToggle={toggle(setOpenEmpty, 'sec.empty', openEmpty)} collapsed={collapsed}>
            {empty.map((p) => (
              <div key={p.id} className="nav-row">
                <div className="nav-item muted" title={collapsed ? t("{0} – nicht installiert", [p.name]) : p.error || (p.download ? t("{0} ist nicht installiert", [p.name]) : t("Launcher nicht installiert oder keine Spiele gefunden"))}>
                  <span className="nav-icon"><LauncherLogo provider={p} dim /></span>
                  <span className="label">{p.name}</span>
                  {p.error && <span className="warn">!</span>}
                </div>
                {p.download && !collapsed && (
                  <button className="nav-open nav-download" onClick={() => onOpenLauncher(p.id, 'download')} title={t("{0} herunterladen", [p.name])}
                    aria-label={t("{0} herunterladen", [p.name])}>
                    <DownloadIcon />
                  </button>
                )}
              </div>
            ))}
          </Section>
        )}
      </nav>
      <div className="sidebar-tools">
        <button className={`tool-btn ${downloads.active ? 'active' : ''}`} onClick={onDownloads} title={tip(t("Downloads"), downloads.total)}>
          <span className="nav-icon"><DownloadIcon /></span>
          <span className="label">{t("Downloads")}</span>
          {downloads.total > 0 && <span className={`tool-badge ${downloads.active ? 'live' : ''}`}>{downloads.progress != null && downloads.active ? `${Math.round(downloads.progress * 100)} %` : downloads.total}</span>}
        </button>
      </div>
      <div className="sidebar-actions">
        <button className="add-btn" onClick={onAdd} title={collapsed ? t("Spiel hinzufügen") : undefined}>
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
          <span className="label">{t("Spiel hinzufügen")}</span>
        </button>
      </div>
    </aside>)
  );
}

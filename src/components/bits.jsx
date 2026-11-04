import React, { useState } from 'react';
import gamehubLogo from '../assets/logo.svg';
import { t, DEC, LOCALE } from '../i18n.js';

/** Logo des Launchers (Programm-Symbol von deinem PC), sonst der Farbpunkt */
export function LauncherLogo({ provider, dim = false, small = false }) {
  const [ok, setOk] = useState(true);
  // "Eigene Spiele" haben keinen Launcher -> Ludora-Logo
  if (provider?.id === 'manual') {
    return <img className={`launcher-logo ${small ? 'small' : ''} ${dim ? 'dim' : ''}`} src={gamehubLogo} alt="" draggable={false} />;
  }
  if (provider?.logo && ok) {
    return (
      <img
        className={`launcher-logo ${small ? 'small' : ''} ${dim ? 'dim' : ''}`}
        src={provider.logo}
        alt=""
        draggable={false}
        onError={() => setOk(false)}
      />
    );
  }
  return <span className={`dot ${small ? 'small' : ''}`} style={{ background: provider?.accent, opacity: dim ? 0.35 : 1 }} />;
}

export const ImageIcon = () => (
  <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></svg>
);

export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" className="fill"><path d="M8 5.5v13l11-6.5z" /></svg>
);
export const DownloadIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
);
export const FolderIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);
export const StarIcon = ({ filled = false }) => (
  <svg viewBox="0 0 24 24" className={filled ? 'star filled' : 'star'}>
    <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
  </svg>
);

/** Stern-Knopf zum (Ent-)Favorisieren */
export function FavButton({ active, onToggle, className = '' }) {
  return (
    (<button
      className={`fav-btn ${active ? 'on' : ''} ${className}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={active ? t("Aus Favoriten entfernen") : t("Zu Favoriten hinzufügen")}
      aria-pressed={active}
    >
      <StarIcon filled={active} />
    </button>)
  );
}

export const TrashIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
);
export const OpenIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
);
export const StoreIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M4 9l1.5-5h13L20 9M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9M9 20v-5h6v5" /></svg>
);
export const RefreshIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></svg>
);
export const UsersIcon = () => (
  <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.2a5 5 0 0 1 5.5 4.8" /></svg>
);
// Freunde-Symbol mit Plus (Freund hinzufügen)
export const UserAddIcon = () => (
  <svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3.5" /><path d="M1.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="15.5" cy="9" r="2.3" /><path d="M14.8 13.6a5 5 0 0 1 2.2.4" /><path d="M19.5 14v7M16 17.5h7" /></svg>
);
// Freunde-Symbol mit Kopieren-Zeichen (Namen kopieren, um ihn im Launcher hinzuzufügen)
export const UserCopyIcon = () => (
  <svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3.5" /><path d="M1.5 20a6.5 6.5 0 0 1 11 0" /><circle cx="15.5" cy="7.5" r="2.3" /><rect x="15" y="14.5" width="6" height="7" rx="1.2" /><path d="M13 19.5v-5.8a1.2 1.2 0 0 1 1.2-1.2H19" /></svg>
);
export const GearIcon = () => (
  <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);

const LABELS = {
  installed: null, // Standardfall, kein Label auf dem Cover
  updating: t("Update ausstehend"),
  missing: t("Datei fehlt"),
  notInstalled: t("Nicht installiert")
};

const UPDATE_PILL = {
  downloading: [t("Lädt"), 'dl'],
  queued: [t("Wartet auf Download"), 'dl'],
  paused: [t("Update pausiert"), 'updating'],
  available: [t("Update verfügbar"), 'updating']
};

export function StatusPill({ status, update, running, inline = false }) {
  if (running) return <span className={`pill live ${inline ? '' : 'floating'}`}><span className="live-dot" />{t("Läuft")}</span>;
  if (update && UPDATE_PILL[update.state] && (status !== 'notInstalled' || update.state === 'downloading' || update.state === 'paused')) {
    const [text, cls] = UPDATE_PILL[update.state];
    const pct = update.state === 'downloading' && update.progress !== undefined ? ` ${Math.round(update.progress * 100)} %` : '';
    return <span className={`pill ${cls} ${inline ? '' : 'floating'}`}>{text}{pct}</span>;
  }
  const label = LABELS[status];
  if (!label) return inline ? <span className="pill ok">{t("Installiert")}</span> : null;
  if (status === 'notInstalled' && !inline) return null; // auf dem Cover reicht der Grau-Effekt
  return <span className={`pill ${status} ${inline ? '' : 'floating'}`}>{label}</span>;
}

export function formatPlaytime(min) {
  if (!min) return '';
  if (min < 60) return t("{0} Min.", [min]);
  const h = min / 60;
  return t("{0} Std.", [h < 10 ? h.toFixed(1).replace('.', DEC) : Math.round(h).toLocaleString(LOCALE)]);
}

/** Haupt-Knopf: Spielen, Update oder Installieren */
export function ActionButton({ game, launching, onPlay, onUpdate, running, onFocus, small = false }) {
  const install = game.status === 'notInstalled';
  if (game.busy) {
    return <button className={`play ${small ? 'small' : ''}`} disabled><span className="loader small" />{game.busy}</button>;
  }
  if (running && !install) {
    return (
      (<button className={`play ${small ? 'small' : ''} is-running`} onClick={onFocus} title={t("Läuft gerade – Klick holt das Spiel nach vorne")}>
        <span className="live-dot" />{t("Läuft")}</button>)
    );
  }
  // Auch Erstinstallationen zeigen ihren Fortschritt (z. B. Battle.net lädt gerade)
  const u = game.update && (!install || game.update.state === 'downloading' || game.update.state === 'paused') ? game.update : null;
  if (u) {
    const downloading = u.state === 'downloading';
    return (
      (<button className={`play ${small ? 'small' : ''} update ${downloading ? 'running' : ''}`} onClick={onUpdate}
        title={downloading ? t("Download läuft – Launcher öffnen") : t("Update im Launcher starten")}>
        {downloading ? <DownloadIcon /> : <RefreshIcon />}
        {downloading ? (u.progress !== undefined ? `${Math.round(u.progress * 100)} %` : t("Lädt …")) : t("Update")}
      </button>)
    );
  }
  const disabled = game.status === 'missing' || launching;
  return (
    (<button className={`play ${small ? 'small' : ''} ${install ? 'install' : ''}`} onClick={onPlay} disabled={disabled}>
      {install ? <DownloadIcon /> : <PlayIcon />}
      {launching ? (install ? t("Öffnet …") : t("Startet …")) : install ? t("Installieren") : t("Spielen")}
    </button>)
  );
}

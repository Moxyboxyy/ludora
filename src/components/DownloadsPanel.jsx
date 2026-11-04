import React from 'react';
import Cover from './Cover.jsx';
import { LauncherLogo, DownloadIcon } from './bits.jsx';
import { t, DEC } from '../i18n.js';

export function formatBytes(b) {
  if (!b) return '';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1).replace('.', DEC)} GB`;
  return `${Math.round(b / 1024 ** 2)} MB`;
}

const GROUPS = [
  ['downloading', t("Läuft")],
  ['queued', t("In der Warteschlange")],
  ['paused', t("Pausiert")],
  ['available', t("Updates verfügbar")]
];

export function formatSpeed(bps) {
  if (!bps) return '';
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1).replace('.', DEC)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

export function formatEta(sec, upper = false) {
  if (sec === null || sec === undefined || !isFinite(sec)) return '';
  const pre = upper ? t("noch höchstens") : t("noch ca.");
  if (sec < 60) return t("noch < 1 Min.");
  const min = Math.round(sec / 60);
  if (min < 60) return t("{0} {1} Min.", [pre, min]);
  const h = Math.floor(min / 60);
  return t("{0} {1} Std. {2} Min.", [pre, h, min % 60]);
}

export function updateLabel(u) {
  if (!u) return '';
  if (u.state === 'downloading') return u.progress !== undefined ? t("Lädt {0} %", [Math.round(u.progress * 100)]) : t("Lädt …");
  if (u.state === 'paused') return t("Pausiert");
  if (u.state === 'queued') return t("Wartet");
  return t("Update verfügbar");
}

export default function DownloadsPanel({ games, providerById, onClose, onOpen, onUpdate, onManage }) {
  const withUpdate = games.filter((g) => g.update);
  return (
    (<div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2><DownloadIcon /> {t("Downloads")}</h2>
          <button className="ghost" onClick={onClose} title={t("Schließen")}>✕</button>
        </header>

        {withUpdate.length === 0 && (
          <div className="drawer-empty">{t("Alles aktuell – gerade läuft kein Download und es steht kein Update an.")}</div>
        )}

        {GROUPS.map(([state, title]) => {
          const list = withUpdate.filter((g) => g.update.state === state);
          if (!list.length) return null;
          return (
            (<section key={state} className="dl-group">
              <h3>{title} <span className="count">{list.length}</span></h3>
              {list.map((g) => (
                <div key={g.id} className="dl-row">
                  <div className="thumb small">
                    <Cover game={{ ...g, covers: [...(g.wides || []), ...(g.covers || [])] }} provider={providerById[g.provider]} wide />
                  </div>
                  <div className="dl-info">
                    <div className="dl-name" title={g.name}>{g.name}</div>
                    <div className="dl-meta">
                      <LauncherLogo provider={providerById[g.provider]} small />
                      {providerById[g.provider]?.name}
                      {g.update.detail && <> · {g.update.detail}</>}
                      {g.update.bytesTotal > 0 && (
                        <> · {g.update.bytesDone ? t("{0} von ", [formatBytes(g.update.bytesDone)]) : ''}{g.update.etaUpper ? t("ca. ") : ''}{formatBytes(g.update.bytesTotal)}</>
                      )}
                    </div>
                    {(state === 'downloading' || state === 'paused') && (
                      g.update.progress !== undefined
                        ? (
                          <div className="progress-row">
                            <div className="progress"><span style={{ width: `${Math.round(g.update.progress * 100)}%` }} /></div>
                            <span className="pct">{Math.round(g.update.progress * 100)} %</span>
                          </div>
                        )
                        : state === 'downloading' ? <div className="progress indeterminate"><span /></div> : null
                    )}
                    {state === 'downloading' && (g.update.speed > 0 || g.update.eta) && (
                      <div className="dl-meta speed">
                        {g.update.speed > 0 && <span>⬇ {formatSpeed(g.update.speed)}</span>}
                        {formatEta(g.update.eta, g.update.etaUpper) && <span>{formatEta(g.update.eta, g.update.etaUpper)}</span>}
                      </div>
                    )}
                    {state === 'downloading' && !g.update.speed && !g.update.eta && <div className="dl-meta">{t("Geschwindigkeit wird gemessen …")}</div>}
                    {state === 'downloading' && (g.update.live || g.update.source) && (g.update.speed > 0 || g.update.eta) && (
                      <div className="dl-meta source">
                        {g.update.live ? t("Live gemessen, jede Sekunde") : t("Werte direkt von {0}", [g.update.source])}
                      </div>
                    )}
                    {g.update.firstInstall && <div className="dl-meta">{t("Erstinstallation")}</div>}
                  </div>
                  <div className="dl-actions">
                    {state === 'downloading' && (
                      <button className="secondary small icon-only" onClick={() => onManage(g)} title={g.provider === 'battlenet' ? t("Pausieren") : t("Pausieren (öffnet die Download-Ansicht des Launchers)")}>
                        <svg viewBox="0 0 24 24" className="fill"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                      </button>
                    )}
                    {state === 'paused' && (
                      <button className="secondary small" onClick={() => onManage(g)} title={g.provider === 'battlenet' ? t("Fortsetzen") : t("Fortsetzen (öffnet die Download-Ansicht des Launchers)")}>
                        <svg viewBox="0 0 24 24" className="fill"><path d="M8 5.5v13l11-6.5z" /></svg> {t("Fortsetzen")}</button>
                    )}
                    {state === 'available' && (
                      <button className="secondary small" onClick={() => onUpdate(g)} title={t("Im Hintergrund aktualisieren")}>{t("Update")}</button>
                    )}
                    {state !== 'available' && (
                      <button className="ghost" onClick={() => onOpen(g)} title={t("Launcher sichtbar öffnen")}>
                        <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>)
          );
        })}

        <p className="hint small drawer-foot">{t(
          "„Update“ startet den Launcher unsichtbar, er lädt dann selbst. Pausieren und Fortsetzen erlauben die Launcher nur in ihrer eigenen Download-Ansicht – der Knopf öffnet sie direkt. Geschwindigkeit und Restzeit misst Ludora selbst."
        )}</p>
      </aside>
    </div>)
  );
}

import React, { useEffect } from 'react';
import logoUrl from '../assets/logo.svg';
import { t, language } from '../i18n.js';

/**
 * Was ist neu? Aus den Release-Notes (GitHub) die passende Sprache holen:
 * Deutsch = Absatz nach "**Deutsch:**", sonst die Punkte unter "### What's new".
 * -> [{ text, bold }] je Punkt (einfaches Markdown: **fett**, `code`)
 */
export function noteItems(notes, lang = language) {
  const md = String(notes || '').replace(/\r/g, '');
  if (!md) return [];
  if (lang === 'de') {
    const m = md.match(/\*\*Deutsch:\*\*\s*([\s\S]*?)(?:\n\s*\n|$)/);
    if (m) return [m[1].trim()];
  }
  const sec = md.match(/###\s*What's new\s*\n([\s\S]*?)(?:\n###|\n---|$)/i);
  const body = sec ? sec[1] : md;
  return body.split('\n').map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ''));
}

/** **fett** und `code` als React-Elemente */
function Inline({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => (p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b>
    : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <React.Fragment key={i}>{p}</React.Fragment>));
}

/** Eigener Dialog für Ludora-Updates (statt des Standardfensters von Windows/macOS/Linux) */
export default function UpdateDialog({ update, onConfirm, onClose }) {
  const busy = update?.status === 'downloading' || update?.status === 'installing';
  const pct = Math.round((update?.progress || 0) * 100);
  const items = noteItems(update?.notes);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div className="modal update-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="update-head">
          <img src={logoUrl} alt="" draggable={false} />
          <div>
            <h2>{t("Ludora {0} ist da", [update?.latest])}</h2>
            <p className="hint">{t("Du hast Version {0}", [update?.current])}</p>
          </div>
        </div>

        {items.length > 0 && (
          <div className="update-notes">
            <div className="update-notes-title">{t("Was ist neu")}</div>
            <ul>{items.map((x, i) => <li key={i}><Inline text={x} /></li>)}</ul>
          </div>
        )}

        {busy ? (
          <div className="update-progress">
            <div className="update-bar"><span style={{ width: `${update.status === 'installing' ? 100 : pct}%` }} className={update.status === 'installing' ? 'pulse' : ''} /></div>
            <div className="hint">{update.status === 'installing'
              ? t("Wird installiert – Ludora startet gleich neu …")
              : t("Wird geladen … {0} %", [pct])}</div>
          </div>
        ) : (
          <p className="hint">{t("Ludora lädt das Update herunter, installiert es und startet danach neu. Deine Einstellungen und Anmeldungen bleiben erhalten.")}</p>
        )}
        {update?.error && !busy && <p className="form-error">{t("Update fehlgeschlagen: {0}", [update.error])}</p>}

        <div className="modal-actions">
          {!busy && <button className="secondary" onClick={onClose}>{t("Später")}</button>}
          {!busy && <button className="primary" onClick={onConfirm} autoFocus>{t("Jetzt aktualisieren")}</button>}
        </div>
      </div>
    </div>
  );
}

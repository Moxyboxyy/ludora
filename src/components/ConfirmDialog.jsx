import React, { useEffect } from 'react';
import { t } from '../i18n.js';

/** Rückfrage im Ludora-Stil (statt des System-Dialogs). Enter bestätigt, Esc bricht ab. */
export default function ConfirmDialog({ title, message, detail, confirmLabel, danger = false, onConfirm, onCancel }) {
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form className="modal confirm" role="alertdialog" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onConfirm(); }}>
        <h2 id="confirm-title">{title}</h2>
        <p className="confirm-msg">{message}</p>
        {detail && <p className="hint">{detail}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>{t("Abbrechen")}</button>
          <button type="submit" className={danger ? 'danger-btn' : 'primary'} autoFocus>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

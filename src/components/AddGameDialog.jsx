import React, { useState } from 'react';
import { api } from '../api.js';
import { t } from '../i18n.js';

export default function AddGameDialog({ onClose, onAdded }) {
  const [exe, setExe] = useState('');
  const [name, setName] = useState('');
  const [args, setArgs] = useState('');
  const [error, setError] = useState('');

  async function pick() {
    const file = await api.pickExe();
    if (!file) return;
    setExe(file);
    if (!name) {
      const base = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      setName(base);
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (!exe) { setError(t("Bitte zuerst eine Datei auswählen.")); return; }
    const res = await api.addManual({ exe, name: name.trim(), args: args.trim() });
    if (res.ok) onAdded(name.trim() || t("Spiel"));
    else setError(res.error);
  }

  return (
    (<div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{t("Spiel hinzufügen")}</h2>
        <p className="hint">{t(
          "Für Spiele ohne Launcher oder aus Launchern, die Ludora noch nicht kennt."
        )}</p>

        <label>{t("Datei")}</label>
        <div className="file-pick">
          <input value={exe} readOnly placeholder={t("Keine Datei gewählt")} />
          <button type="button" className="secondary" onClick={pick}>{t("Durchsuchen")}</button>
        </div>

        <label>{t("Name")}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Minecraft" />

        <label>{t("Startparameter")} <span className="opt">(optional)</span></label>
        <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="z. B. -windowed" />

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t("Abbrechen")}</button>
          <button type="submit" className="primary">{t("Hinzufügen")}</button>
        </div>
      </form>
    </div>)
  );
}

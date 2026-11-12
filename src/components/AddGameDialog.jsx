import React, { useState } from 'react';
import { api } from '../api.js';
import { t } from '../i18n.js';

const fileName = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

/** Spiel oder eigenen Launcher hinzufügen. customLaunchers: [{ id, name }] */
export default function AddGameDialog({ onClose, onAdded, customLaunchers = [], initialMode = 'game' }) {
  const [mode, setMode] = useState(initialMode);
  const [exe, setExe] = useState('');
  const [name, setName] = useState('');
  const [args, setArgs] = useState('');
  const [launcher, setLauncher] = useState('manual');
  const [folder, setFolder] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const switchMode = (m) => { setMode(m); setError(''); setExe(''); setName(''); setFolder(''); };

  async function pick() {
    const file = await (mode === 'launcher' ? api.pickLauncher() : api.pickExe());
    if (!file) return;
    setExe(file);
    if (!name) setName(fileName(file));
  }
  async function pickFolder() {
    const dir = await api.pickFolder();
    if (dir) setFolder(dir);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (mode === 'launcher') {
      if (!name.trim()) { setError(t("Bitte einen Namen eingeben.")); return; }
      if (!exe && !folder) { setError(t("Wähle das Programm des Launchers oder einen Spieleordner (oder beides).")); return; }
      setBusy(true);
      const res = await api.custom.add({ name: name.trim(), exe, folder });
      setBusy(false);
      if (res.ok) onAdded(name.trim(), res.launcher?.id);
      else setError(res.error);
      return;
    }
    if (!exe) { setError(t("Bitte zuerst eine Datei auswählen.")); return; }
    const res = await api.addManual({ exe, name: name.trim(), args: args.trim(), launcher });
    if (res.ok) onAdded(name.trim() || t("Spiel"));
    else setError(res.error);
  }

  return (
    (<div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{mode === 'launcher' ? t("Launcher hinzufügen") : t("Spiel hinzufügen")}</h2>
        <div className="seg add-mode">
          <button type="button" className={mode === 'game' ? 'on' : ''} onClick={() => switchMode('game')}>{t("Neues Spiel")}</button>
          <button type="button" className={mode === 'launcher' ? 'on' : ''} onClick={() => switchMode('launcher')}>{t("Neuer Launcher")}</button>
        </div>

        {mode === 'game' ? (
          <>
            <p className="hint">{t("Für Spiele ohne Launcher oder aus Launchern, die Ludora noch nicht kennt.")}</p>
            <label>{t("Datei")}</label>
            <div className="file-pick">
              <input value={exe} readOnly placeholder={t("Keine Datei gewählt")} />
              <button type="button" className="secondary" onClick={pick}>{t("Durchsuchen")}</button>
            </div>
            <label>{t("Name")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("z. B. Minecraft")} />
            {customLaunchers.length > 0 && (
              <>
                <label>{t("Gehört zu")}</label>
                <select className="modal-select" value={launcher} onChange={(e) => setLauncher(e.target.value)}>
                  <option value="manual">{t("Eigene Spiele")}</option>
                  {customLaunchers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </>
            )}
            <label>{t("Startparameter")} <span className="opt">({t("optional")})</span></label>
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder={t("z. B. -windowed")} />
          </>
        ) : (
          <>
            <p className="hint">{t("Ein Launcher, den Ludora nicht kennt (z. B. itch.io oder ein Spieleordner) – mit seinen Spielen in der Seitenleiste. Ohne Freundesliste.")}</p>
            <label>{t("Name")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("z. B. itch.io")} autoFocus />
            <label>{t("Programm des Launchers")} <span className="opt">({t("optional")})</span></label>
            <div className="file-pick">
              <input value={exe} readOnly placeholder={t("Zum Öffnen des Launchers aus Ludora")} />
              <button type="button" className="secondary" onClick={pick}>{t("Durchsuchen")}</button>
            </div>
            <label>{t("Spieleordner")} <span className="opt">({t("optional")})</span></label>
            <div className="file-pick">
              <input value={folder} readOnly placeholder={t("Leer lassen: Ludora sucht selbst im Launcher")} />
              <button type="button" className="secondary" onClick={pickFolder}>{t("Durchsuchen")}</button>
            </div>
            <p className="hint small">{t("Ohne Spieleordner sucht Ludora die Spiele selbst im Ordner des Launchers und in seinen Datenordnern (z. B. „apps“ oder „games“). Jeder Unterordner dort wird ein Spiel. Einzelne Spiele kannst du danach über „Spiel hinzufügen“ zuordnen.")}</p>
          </>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t("Abbrechen")}</button>
          <button type="submit" className="primary" disabled={busy}>{t("Hinzufügen")}</button>
        </div>
      </form>
    </div>)
  );
}

import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { t, DEC, LANGUAGES } from '../i18n.js';

function formatBytes(b) {
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1).replace('.', DEC)} MB`;
}

export default function SettingsDialog({ onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(null);
  const [accountMsg, setAccountMsg] = useState('');
  const [cache, setCache] = useState(null);

  useEffect(() => {
    api.getSettings().then((s) => setForm(s));
    api.cacheInfo().then((c) => setCache(c.bytes)).catch(() => setCache(0));
  }, []);

  if (!form) return null;

  async function submit(e) {
    e.preventDefault();
    await api.setSettings({
      steamApiKey: form.steamApiKey,
      steamId: form.steamId,
      steamGridDbKey: form.steamGridDbKey,
      launcherMode: form.launcherMode,
      enabledLaunchers: form.enabledLaunchers,
      closeToTray: form.closeToTray,
      language: form.language,
      bnetAccountLibrary: form.bnetAccountLibrary,
      autostart: form.autostart
    });
    onSaved();
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function connect(id) {
    setBusy(id);
    setAccountMsg('');
    const res = await api.accountLogin(id);
    setBusy(null);
    if (res.ok) {
      setAccountMsg(t(
        "Verbunden – {0} Spiele gefunden. Die Bibliothek wird beim Speichern neu geladen.",
        [res.count]
      ));
      setForm((f) => ({ ...f, accounts: { ...f.accounts, [id]: { connected: true, count: res.count } } }));
    } else setAccountMsg(res.error || t("Anmeldung fehlgeschlagen"));
  }

  async function disconnect(id) {
    await api.accountLogout(id);
    setForm((f) => ({ ...f, accounts: { ...f.accounts, [id]: { connected: false } } }));
    setAccountMsg(t("Abgemeldet."));
  }

  function toggle(id) {
    setForm((f) => ({ ...f, enabledLaunchers: { ...f.enabledLaunchers, [id]: f.enabledLaunchers[id] === false } }));
  }

  async function clearCache() {
    const res = await api.clearCache();
    setCache(res.bytes);
  }

  return (
    (<div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{t("Einstellungen")}</h2>
        <p className="hint">{t(
          "Ludora funktioniert ohne Anmeldung und ohne Keys: Spiele, Bibliothek und Cover werden direkt von deinem PC gelesen. Alles hier ist optional."
        )}</p>

        <h3>{t("Sprache")}</h3>
        <div className="segmented text lang-switch" role="radiogroup" aria-label={t("Sprache")}>
          {LANGUAGES.map(([code, label]) => (
            <button type="button" key={code} role="radio" aria-checked={form.language === code}
              className={form.language === code ? 'on' : ''} onClick={() => setForm({ ...form, language: code })}>
              {label}
            </button>
          ))}
        </div>
        <p className="hint small">{t("Wird beim Speichern übernommen.")}</p>

        <h3>{t("Ludora-Fenster")}</h3>
        <div className="launcher-list">
          <div className="launcher-row">
            <label className="switch">
              <input type="checkbox" checked={form.closeToTray !== false} onChange={(e) => setForm({ ...form, closeToTray: e.target.checked })} />
              <span />
            </label>
            <div className="account-info">
              <b>{t("Beim Schließen im Hintergrund weiterlaufen")}</b>
              <small>{api.platform === 'darwin' ? t("Ludora bleibt oben in der Menüleiste.") : t("Ludora bleibt als Symbol unten rechts neben der Uhr.")} {t("Beenden über das Symbol.")}</small>
            </div>
          </div>
          <div className={`launcher-row ${form.autostartAvailable ? '' : 'off'}`}>
            <label className="switch">
              <input type="checkbox" disabled={!form.autostartAvailable} checked={!!form.autostart} onChange={(e) => setForm({ ...form, autostart: e.target.checked })} />
              <span />
            </label>
            <div className="account-info">
              <b>{t("Mit dem System starten")}</b>
              <small>{form.autostartAvailable ? t("Startet beim Anmelden unsichtbar im Hintergrund.") : t("Nur in der installierten App verfügbar.")}</small>
            </div>
          </div>
        </div>

        <h3>{t("Launcher beim Spielstart")}</h3>
        <div className="radio-group">
          {[
            ['hide', t("Ganz verstecken"), api.platform === 'darwin'
              ? t("Launcher wird ausgeblendet (wie Cmd+H), läuft aber weiter.")
              : t("Launcher läuft nur im Tray (Symbol unten rechts neben der Uhr).")],
            ['minimize', t("Minimieren"), api.platform === 'darwin'
              ? t("Auf dem Mac wie „Ganz verstecken“.")
              : t("Launcher bleibt in der Taskleiste, kommt aber nicht nach vorne.")],
            ['off', t("Normal anzeigen"), t("Ludora greift nicht ein.")]
          ].map(([value, label, hint]) => (
            <label key={value} className={`radio ${form.launcherMode === value ? 'on' : ''}`}>
              <input type="radio" name="launcherMode" value={value} checked={form.launcherMode === value} onChange={set('launcherMode')} />
              <span><b>{label}</b><small>{hint}</small></span>
            </label>
          ))}
        </div>
        <p className="hint small">{t(
          "Über die Launcher-Buttons in der Seitenleiste kannst du jeden Launcher jederzeit ganz normal öffnen."
        )}</p>

        <h3>{t("Launcher")}</h3>
        <p className="hint small">{t(
          "Nur eingeschaltete Launcher erscheinen links und werden gelesen. Ausgeschaltete laden auch keine Cover."
        )}</p>
        <div className="launcher-list">
          {form.launchers.map((l) => {
            const on = form.enabledLaunchers[l.id] !== false;
            const acc = form.accounts?.[l.id];
            return (
              (<div key={l.id} className={`launcher-row ${on ? '' : 'off'}`}>
                <label className="switch" title={on ? t("Ausschalten") : t("Einschalten")}>
                  <input type="checkbox" checked={on} onChange={() => toggle(l.id)} />
                  <span />
                </label>
                <span className="dot" style={{ background: l.accent }} />
                <div className="account-info">
                  <b>{l.name}</b>
                  {l.account && (
                    <small>
                      {acc?.connected
                        ? t("Angemeldet · {0} Spiele in deiner Bibliothek", [acc.count])
                        : t("Optional anmelden für die komplette Bibliothek")}
                    </small>
                  )}
                </div>
                {l.account && on && (acc?.connected ? (
                  <button type="button" className="secondary small" onClick={() => disconnect(l.id)}>{t("Abmelden")}</button>
                ) : (
                  <button type="button" className="secondary small" disabled={busy === l.id} onClick={() => connect(l.id)}>
                    {busy === l.id ? t("Fenster offen …") : t("Anmelden")}
                  </button>
                ))}
              </div>)
            );
          })}
        </div>
        {accountMsg && <p className="hint small">{accountMsg}</p>}
        <p className="hint small">{t(
          "Anmelden läuft über die echte Seite des Anbieters in einem eigenen Fenster. Ludora sieht dein Passwort nicht und speichert nur das Login-Cookie auf diesem PC. Battle.net nutzt dafür eine nicht offiziell dokumentierte Schnittstelle; laut Blizzard kann deren Nutzung gegen die Nutzungsbedingungen verstoßen."
        )}</p>

        <h3>{t("Erweitert")}</h3>
        <div className="launcher-list">
          <div className="launcher-row">
            <label className="switch">
              <input type="checkbox" checked={!!form.bnetAccountLibrary}
                onChange={(e) => setForm({ ...form, bnetAccountLibrary: e.target.checked, launchers: form.launchers.map((l) => (l.id === 'battlenet' ? { ...l, account: e.target.checked } : l)) })} />
              <span />
            </label>
            <div className="account-info">
              <b>{t("Battle.net: komplette Bibliothek über die Kontoanmeldung")}</b>
              <small>{t(
                "Zeigt auch nicht installierte Blizzard-Spiele. Nutzt eine inoffizielle Schnittstelle – laut Blizzard kann das gegen die Nutzungsbedingungen verstoßen. Auf eigenes Risiko."
              )}</small>
            </div>
          </div>
        </div>

        <h3>{t("Speicher")}</h3>
        <div className="account-row">
          <div className="account-info">
            <b>{t("Bild-Zwischenspeicher: {0}", [cache === null ? '…' : formatBytes(cache)])}</b>
            <small>{t(
              "Höchstens 200 MB. Cover werden nach dem Leeren beim nächsten Anzeigen neu geladen."
            )}</small>
          </div>
          <button type="button" className="secondary small" onClick={clearCache} disabled={!cache}>{t("Leeren")}</button>
        </div>

        <h3>{t("Steam-Konto")}</h3>
        <label>{t("SteamID64")}</label>
        <input
          value={form.steamId}
          onChange={set('steamId')}
          placeholder={form.detectedSteamId ? t("Automatisch: {0}", [form.detectedSteamId]) : '7656119…'}
          spellCheck={false}
        />
        <p className="hint small">{t("Nur ändern, wenn auf dem PC mehrere Steam-Konten genutzt werden.")}</p>

        <details className="advanced">
          <summary>{t("Erweitert")}</summary>

          <label>{t("Steam-API-Key")}</label>
          <p className="hint small">{t(
            "Liefert die offizielle Liste deiner Steam-Spiele. Ohne Key nimmt Ludora die Spiele, die Steam auf deinem PC zwischengespeichert hat. Das sind normalerweise alle, aber nach einer frischen Steam-Installation können ein paar fehlen."
          )}{' '}
            <button type="button" className="link" onClick={() => api.openExternal('https://steamcommunity.com/dev/apikey')}>{t("Key holen")}</button>
          </p>
          <div className="file-pick">
            <input
              type={showKey ? 'text' : 'password'}
              value={form.steamApiKey}
              onChange={set('steamApiKey')}
              placeholder="optional"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="secondary" onClick={() => setShowKey(!showKey)}>
              {showKey ? t("Verbergen") : t("Zeigen")}
            </button>
          </div>

          <label>{t("SteamGridDB-API-Key")}</label>
          <p className="hint small">{t(
            "Für Cover von Spielen, die es nicht auf Steam gibt (z. B. Valorant, League of Legends)."
          )}{' '}
            <button type="button" className="link" onClick={() => api.openExternal('https://www.steamgriddb.com/profile/preferences/api')}>{t("Key holen")}</button>
          </p>
          <input
            type={showKey ? 'text' : 'password'}
            value={form.steamGridDbKey}
            onChange={set('steamGridDbKey')}
            placeholder="optional"
            autoComplete="off"
            spellCheck={false}
          />
        </details>

        <h3>{t("Rechtliches")}</h3>
        <p className="hint small legal">{t(
          "Ludora ist ein privates Open-Source-Projekt und nicht mit Valve (Steam), Epic Games, GOG, Electronic Arts, Ubisoft, Blizzard (Battle.net), Riot Games, Rockstar Games oder Amazon verbunden. Alle Namen und Marken gehören ihren Inhabern. Ludora isn’t endorsed by Riot Games and doesn’t reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc. Preisdaten teils von CheapShark."
        )}</p>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t("Abbrechen")}</button>
          <button type="submit" className="primary">{t("Speichern")}</button>
        </div>
      </form>
    </div>)
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TESTS, EVENTS, call, createContext, runTest } from './suite.js';

// Debug-Fenster der Testversion: jede Funktion mit Ampel (grün bestanden, gelb teilweise, rot nicht bestanden),
// Begründung und Knopf zum Ausführen. Öffnet sich mit Ludora (nur `npm run dev`, nie im Release).
const LABEL = { ok: 'bestanden', warn: 'teilweise', fail: 'nicht bestanden', running: 'läuft …' };

export default function DebugWindow() {
  const ctx = useRef(createContext());
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState({});
  const [status, setStatus] = useState(null);
  const [opts, setOpts] = useState({});
  const [p, setP] = useState({ text: 'Test von Ludora', launcher2: 'epic' });
  const [filter, setFilter] = useState('all');
  const [lists, setLists] = useState({ games: [], providers: [], friends: [], links: [] });

  const refreshLists = useCallback(async () => {
    try {
      const [scan, steam, hub] = await Promise.all([call('library:cached'), call('friends:get'), call('hub:get')]);
      const s = ctx.current.scan || scan;
      setLists({
        games: (s?.games || []).map((g) => ({ id: g.id, name: `${g.name} (${g.provider}${g.status === 'notInstalled' ? ', nicht installiert' : ''})` })),
        providers: (s?.providers || []).filter((x) => x.installed || x.count).map((x) => ({ id: x.id, name: x.name })),
        friends: (steam?.friends || []).map((f) => ({ id: f.steamid, name: `${f.name} (${f.state || 'offline'})` })),
        links: (hub?.links || []).map((l) => ({ id: `${l.launcher}|${l.account_id}`, name: `${l.launcher}: ${l.account_name || l.account_id}` }))
      });
    } catch { /* egal */ }
  }, []);

  const run = useCallback(async (t) => {
    setResults((r) => ({ ...r, [t.id]: { status: 'running' } }));
    const res = await runTest(t, ctx.current, p);
    setResults((r) => ({ ...r, [t.id]: res }));
    return res;
  }, [p]);

  const runAll = useCallback(async (cli = false) => {
    setBusy(true);
    const sum = { ok: 0, warn: 0, fail: 0, results: [] };
    for (const t of TESTS.filter((x) => x.kind === 'auto')) {
      const res = await run(t);
      sum[res.status] = (sum[res.status] || 0) + 1;
      sum.results.push({ id: t.id, group: t.group, name: t.name, ...res });
      if (cli) await call('debug:report', { name: `${t.group} › ${t.name}`, status: res.status, detail: res.detail || '' }).catch(() => {});
    }
    setBusy(false);
    refreshLists();
    if (cli) await call('debug:finish', sum).catch(() => {});
    return sum;
  }, [run, refreshLists]);

  // Start: Optionen holen; im Befehlszeilen-Modus (npm run selftest) alles automatisch prüfen
  useEffect(() => {
    let stop = [];
    (async () => {
      const o = await call('debug:options').catch(() => ({}));
      setOpts(o);
      for (const ev of EVENTS) {
        stop.push(await listen(ev, () => setEvents((e) => ({ ...e, [ev]: (e[ev] || 0) + 1 }))));
      }
      refreshLists();
      if (o.cli) runAll(true);
    })();
    const timer = setInterval(() => call('debug:status').then(setStatus).catch(() => {}), 3000);
    call('debug:status').then(setStatus).catch(() => {});
    return () => { stop.forEach((f) => f()); clearInterval(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => {
    const s = { ok: 0, warn: 0, fail: 0, open: 0 };
    for (const t of TESTS) s[results[t.id]?.status === 'running' ? 'open' : results[t.id]?.status || 'open']++;
    return s;
  }, [results]);

  const groups = useMemo(() => {
    const g = new Map();
    for (const t of TESTS) {
      const st = results[t.id]?.status;
      if (filter === 'problems' && st !== 'warn' && st !== 'fail') continue;
      if (filter === 'manual' && t.kind !== 'manual') continue;
      if (!g.has(t.group)) g.set(t.group, []);
      g.get(t.group).push(t);
    }
    return [...g];
  }, [results, filter]);

  const needOk = (t) => {
    const n = t.needs || '';
    if (n.includes('game') && !p.game) return 'Spiel wählen';
    if (n === 'launcher' && !p.launcher) return 'Launcher wählen';
    if (n.includes('friend') && !p.friend) return 'Freund wählen';
    if (n.includes('text') && !p.text) return 'Text eingeben';
    if (n.includes('name') && !p.name) return 'Name eingeben';
    if (n.includes('password') && !p.password) return 'Passwort eingeben';
    if (n === 'link' && !p.link) return 'Verknüpfung wählen';
    return null;
  };

  const select = (key, items, label) => (
    <label className="dbg-field">{label}
      <select value={p[key] || ''} onChange={(e) => setP((x) => ({ ...x, [key]: e.target.value }))}>
        <option value="">–</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
    </label>
  );

  return (
    <div className="dbg">
      <header className="dbg-head">
        <div>
          <h1>Ludora · Funktionstest</h1>
          <p className="dbg-sub">Nur in der Testversion. Grün = bestanden, Gelb = teilweise, Rot = nicht bestanden. Automatische Tests ändern nichts Dauerhaftes.</p>
        </div>
        <div className="dbg-sum">
          <span className="dbg-chip ok">{summary.ok}</span>
          <span className="dbg-chip warn">{summary.warn}</span>
          <span className="dbg-chip fail">{summary.fail}</span>
          <span className="dbg-chip open">{summary.open} offen</span>
        </div>
      </header>

      <div className="dbg-bar">
        <button className="dbg-primary" disabled={busy} onClick={() => runAll(false)}>{busy ? 'Prüfe …' : 'Alle automatischen Tests starten'}</button>
        <div className="dbg-tabs">
          {[['all', 'Alle'], ['problems', 'Nur Probleme'], ['manual', 'Nur manuelle']].map(([k, l]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <button onClick={refreshLists}>Listen neu laden</button>
      </div>

      <details className="dbg-params">
        <summary>Eingaben für manuelle Tests</summary>
        <div className="dbg-grid">
          {select('game', lists.games, 'Spiel')}
          {select('launcher', lists.providers, 'Launcher')}
          {select('launcher2', [{ id: 'epic', name: 'Epic' }, { id: 'gog', name: 'GOG' }], 'Epic/GOG')}
          {select('friend', lists.friends, 'Steam-Freund')}
          {select('link', lists.links, 'Verknüpftes Konto')}
          <label className="dbg-field">Text<input value={p.text || ''} onChange={(e) => setP((x) => ({ ...x, text: e.target.value }))} /></label>
          <label className="dbg-field">Ludora-Name<input value={p.name || ''} onChange={(e) => setP((x) => ({ ...x, name: e.target.value }))} /></label>
          <label className="dbg-field">Passwort<input type="password" value={p.password || ''} onChange={(e) => setP((x) => ({ ...x, password: e.target.value }))} /></label>
        </div>
      </details>

      <main className="dbg-list">
        {groups.map(([group, tests]) => (
          <section key={group}>
            <h2>{group}</h2>
            {tests.map((t) => {
              const r = results[t.id];
              const st = r?.status || 'open';
              const missing = t.kind === 'manual' ? needOk(t) : null;
              return (
                <div key={t.id} className={`dbg-row ${st}`}>
                  <span className={`dbg-dot ${st}`} title={LABEL[st] || 'noch nicht geprüft'} />
                  <div className="dbg-main">
                    <div className="dbg-name">
                      {t.name}
                      {t.kind === 'manual' && <span className="dbg-tag">manuell</span>}
                      {t.danger && <span className="dbg-tag danger">verändert etwas</span>}
                      {t.channels.map((c) => <code key={c}>{c}</code>)}
                    </div>
                    {r && r.status !== 'running' && <div className="dbg-detail">{LABEL[r.status]}{r.detail ? ` – ${r.detail}` : ''} <span className="dbg-ms">{r.ms} ms</span></div>}
                  </div>
                  <button disabled={busy || st === 'running' || !!missing} title={missing || ''}
                    onClick={() => { if (!t.danger || window.confirm(`„${t.name}“ wirklich ausführen?`)) run(t); }}>
                    {missing || (st === 'open' ? 'Ausführen' : 'Erneut')}
                  </button>
                </div>
              );
            })}
          </section>
        ))}

        <section>
          <h2>Ereignisse (live)</h2>
          {EVENTS.map((ev) => (
            <div key={ev} className={`dbg-row ${events[ev] ? 'ok' : 'open'}`}>
              <span className={`dbg-dot ${events[ev] ? 'ok' : 'open'}`} />
              <div className="dbg-main"><div className="dbg-name"><code>{ev}</code></div>
                <div className="dbg-detail">{events[ev] ? `${events[ev]}× empfangen` : 'noch nicht empfangen (kommt, sobald sich etwas ändert)'}</div></div>
            </div>
          ))}
        </section>

        {status && (
          <section>
            <h2>Intern</h2>
            <div className="dbg-row ok"><span className={`dbg-dot ${status.steamChat ? 'ok' : 'warn'}`} />
              <div className="dbg-main"><div className="dbg-name">Steam-Chat-Verbindung (CM)</div>
                <div className="dbg-detail">{status.steamChat ? 'verbunden – Nachrichten kommen live' : 'nicht verbunden – Steam angemeldet?'}</div></div></div>
            <div className="dbg-row ok"><span className="dbg-dot ok" />
              <div className="dbg-main"><div className="dbg-name">Datenordner</div><div className="dbg-detail"><code>{status.dataDir}</code> · Protokoll <code>{status.logFile}</code></div></div></div>
            {opts.cli && <div className="dbg-row warn"><span className="dbg-dot warn" /><div className="dbg-main"><div className="dbg-name">Befehlszeilen-Modus</div><div className="dbg-detail">Ergebnisse gehen auch ins Terminal{opts.keep ? '' : '; Ludora schließt sich danach'}</div></div></div>}
          </section>
        )}
      </main>
    </div>
  );
}

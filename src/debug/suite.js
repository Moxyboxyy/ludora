// Funktionstest der Testversion: jede Funktion von Ludora (jeder Kanal der Oberfläche) als Eintrag.
// "auto" läuft von selbst und ändert nichts Dauerhaftes; "manuell" braucht einen Klick (startet Spiele,
// öffnet Fenster, meldet an/ab …). Ergebnis: ok (grün), warn (gelb, teilweise), fail (rot) – immer mit Begründung.
import { invoke } from '@tauri-apps/api/core';

export const call = (channel, ...args) => invoke('ipc', { channel, args });

const ok = (detail = '') => ({ status: 'ok', detail });
const warn = (detail) => ({ status: 'warn', detail });
const fail = (detail) => ({ status: 'fail', detail });
const errText = (e) => String(e?.message || e || 'unbekannter Fehler');
/** Ergebnis {ok:false,error} eines Kanals -> Fehler mit Begründung */
const okRes = (r, what) => {
  if (r && r.ok === false) throw new Error(`${what}: ${r.error || 'ok: false ohne Begründung'}`);
  return r;
};

/** Bild laden (wie die Oberfläche) – true, wenn es lädt */
const loadImage = (src, ms = 8000) => new Promise((resolve) => {
  const img = new Image();
  const t = setTimeout(() => resolve(false), ms);
  img.onload = () => { clearTimeout(t); resolve(img.naturalWidth > 0); };
  img.onerror = () => { clearTimeout(t); resolve(false); };
  img.src = src;
});

// Gemeinsamer Zustand der Tests (Bibliothek, Freunde …), damit spätere Tests darauf aufbauen
export function createContext() {
  return { scan: null, steam: null, friends2: null, hub: null, settings: null };
}

async function ensureScan(ctx) {
  if (!ctx.scan) ctx.scan = await call('library:scan');
  return ctx.scan;
}

export const TESTS = [
  // ---------- App ----------
  { id: 'boot', group: 'App', name: 'Start-Infos (Plattform, Sprache)', channels: ['app:boot'], kind: 'auto',
    run: async () => { const r = await call('app:boot'); return r?.platform ? ok(`${r.platform}, Sprache ${r.language}`) : fail('keine Plattform geliefert'); } },
  { id: 'info', group: 'App', name: 'Version', channels: ['app:info'], kind: 'auto',
    run: async () => { const r = await call('app:info'); return r?.version ? ok(`Ludora ${r.version} (${r.runtime})`) : fail('keine Version'); } },
  { id: 'devtools', group: 'App', name: 'Entwicklerwerkzeuge öffnen', channels: ['app:devtools'], kind: 'manual',
    run: async () => { await call('app:devtools'); return ok('geöffnet (im Hauptfenster: vorher hineinklicken)'); } },
  { id: 'openData', group: 'App', name: 'Datenordner öffnen', channels: ['app:openData'], kind: 'manual',
    run: async () => { await call('app:openData'); return ok('Ordner sollte sich geöffnet haben'); } },
  { id: 'openExternal', group: 'App', name: 'Erlaubten Link im Browser öffnen', channels: ['app:openExternal'], kind: 'manual',
    run: async () => { await call('app:openExternal', 'https://www.steamgriddb.com/profile/preferences/api'); return ok('Browser sollte SteamGridDB zeigen'); } },
  { id: 'quit', group: 'App', name: 'Ludora beenden', channels: ['app:quit'], kind: 'manual', danger: true,
    run: async () => { await call('app:quit'); return ok('beendet'); } },

  // ---------- Einstellungen ----------
  { id: 'settingsGet', group: 'Einstellungen', name: 'Einstellungen lesen', channels: ['settings:get'], kind: 'auto',
    run: async (ctx) => {
      const s = await call('settings:get'); ctx.settings = s;
      if (!Array.isArray(s?.launchers)) return fail('keine Launcher-Liste');
      return ok(`${s.launchers.length} Launcher, Sprache ${s.language}, Autostart ${s.autostartAvailable ? (s.autostart ? 'an' : 'aus') : 'nur in der installierten App'}`);
    } },
  { id: 'settingsSet', group: 'Einstellungen', name: 'Einstellungen speichern (unverändert)', channels: ['settings:set'], kind: 'auto',
    run: async (ctx) => {
      const s = ctx.settings || await call('settings:get');
      const r = okRes(await call('settings:set', { closeToTray: s.closeToTray, launcherMode: s.launcherMode }), 'Speichern');
      return r.languageChanged ? warn('Sprache hat sich unerwartet geändert') : ok('gespeichert');
    } },
  { id: 'cacheInfo', group: 'Einstellungen', name: 'Zwischenspeicher-Größe', channels: ['cache:info'], kind: 'auto',
    run: async () => { const r = await call('cache:info'); return typeof r?.bytes === 'number' ? ok(`${(r.bytes / 1048576).toFixed(1)} MB`) : fail('keine Größe'); } },
  { id: 'cacheClear', group: 'Einstellungen', name: 'Zwischenspeicher leeren', channels: ['cache:clear'], kind: 'manual',
    run: async () => { const r = await call('cache:clear'); return ok(`jetzt ${(r.bytes / 1048576).toFixed(1)} MB`); } },
  { id: 'accountLogin', group: 'Einstellungen', name: 'Battle.net-Konto anmelden (Bibliothek)', channels: ['account:login'], kind: 'manual',
    run: async () => { const r = await call('account:login', 'battlenet'); return r?.ok ? ok('angemeldet') : warn(r?.error || 'abgebrochen'); } },
  { id: 'accountLogout', group: 'Einstellungen', name: 'Battle.net-Konto abmelden', channels: ['account:logout'], kind: 'manual',
    run: async () => { okRes(await call('account:logout', 'battlenet'), 'Abmelden'); return ok('abgemeldet'); } },

  // ---------- Bibliothek ----------
  { id: 'cached', group: 'Bibliothek', name: 'Gespeicherte Bibliothek', channels: ['library:cached'], kind: 'auto',
    run: async () => { const r = await call('library:cached'); return r?.games?.length ? ok(`${r.games.length} Spiele`) : warn('noch keine gespeicherte Bibliothek (normal beim allerersten Start)'); } },
  { id: 'scan', group: 'Bibliothek', name: 'Bibliothek einlesen', channels: ['library:scan'], kind: 'auto',
    run: async (ctx) => {
      ctx.scan = null;
      const r = await ensureScan(ctx);
      const errs = (r.providers || []).filter((p) => p.error && p.enabled !== false).map((p) => `${p.name}: ${p.error}`);
      const per = (r.providers || []).filter((p) => p.count).map((p) => `${p.name} ${p.count}`).join(', ');
      if (!r.games?.length) return fail('keine Spiele gefunden' + (errs.length ? ` – ${errs.join('; ')}` : ''));
      return errs.length ? warn(`${r.games.length} Spiele, aber Fehler: ${errs.join('; ')}`) : ok(`${r.games.length} Spiele (${per})`);
    } },
  { id: 'covers', group: 'Bibliothek', name: 'Cover laden (Stichprobe: 40 Spiele)', channels: [], kind: 'auto',
    run: async (ctx) => {
      const r = await ensureScan(ctx);
      const sample = r.games.slice(0, 40);
      const missing = [];
      let viaIcon = 0;
      for (const g of sample) {
        let loaded = false;
        for (const u of g.covers || []) { if (await loadImage(u)) { loaded = true; break; } }
        if (!loaded && g.iconUrl && await loadImage(g.iconUrl)) { viaIcon++; loaded = true; }
        if (!loaded) missing.push(g.name);
      }
      if (!sample.length) return warn('keine Spiele zum Prüfen');
      if (missing.length === sample.length) return fail(`kein einziges Cover lädt (z. B. ${missing.slice(0, 3).join(', ')}) – Bild-Auslieferung (ghimg) prüfen`);
      if (missing.length) return warn(`${sample.length - missing.length}/${sample.length} laden; ohne Bild: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}`);
      return ok(`alle ${sample.length} laden${viaIcon ? ` (${viaIcon} nur mit Programm-Symbol)` : ''}`);
    } },
  { id: 'launcherLogos', group: 'Bibliothek', name: 'Launcher-Symbole', channels: [], kind: 'auto',
    run: async (ctx) => {
      if (window.gamehub?.platform === 'linux') return ok('unter Linux zeigt Ludora Farbpunkte statt Programm-Symbolen');
      const r = await ensureScan(ctx);
      const withLogo = (r.providers || []).filter((p) => p.logo && (p.installed || p.count));
      const bad = [];
      for (const p of withLogo) if (!await loadImage(p.logo)) bad.push(p.name);
      if (!withLogo.length) return warn('kein installierter Launcher mit Symbol');
      return bad.length ? warn(`ohne Symbol: ${bad.join(', ')}`) : ok(`${withLogo.length} Symbole laden`);
    } },
  { id: 'streams', group: 'Bibliothek', name: 'Streambare Spiele (Steam Remote Play)', channels: ['library:streams'], kind: 'auto',
    run: async () => { const r = await call('library:streams'); return r && typeof r === 'object' ? ok(`${Object.keys(r).length} Spiele auf anderen Geräten`) : fail('keine Antwort'); } },
  { id: 'running', group: 'Bibliothek', name: 'Laufende Spiele erkennen', channels: ['games:running'], kind: 'auto',
    run: async () => { const r = await call('games:running'); return Array.isArray(r) ? ok(r.length ? `läuft: ${r.join(', ')}` : 'gerade läuft kein Spiel') : fail('keine Liste'); } },
  { id: 'downloads', group: 'Bibliothek', name: 'Downloads / Updates erkennen', channels: ['downloads:status'], kind: 'auto',
    run: async () => {
      const r = await call('downloads:status');
      if (!r || typeof r !== 'object') return fail('keine Antwort');
      const items = Object.entries(r).map(([id, d]) => `${id}: ${d.state}${d.speed ? ` (${(d.speed / 1048576).toFixed(1)} MB/s)` : ''}`);
      return ok(items.length ? items.slice(0, 5).join(', ') : 'keine laufenden Downloads oder Updates');
    } },
  { id: 'favorites', group: 'Bibliothek', name: 'Favoriten (an und wieder aus)', channels: ['favorites:get', 'favorites:toggle'], kind: 'auto',
    run: async (ctx) => {
      const r = await ensureScan(ctx);
      const g = r.games[0];
      if (!g) return warn('kein Spiel zum Testen');
      const before = await call('favorites:get');
      const a = await call('favorites:toggle', g.id);
      const b = await call('favorites:toggle', g.id);
      const okA = a.includes(g.id) !== before.includes(g.id);
      const okB = JSON.stringify([...b].sort()) === JSON.stringify([...before].sort());
      return okA && okB ? ok(`${before.length} Favoriten, Umschalten klappt`) : fail('Umschalten liefert falsche Liste');
    } },
  { id: 'manual', group: 'Bibliothek', name: 'Eigenes Spiel hinzufügen und entfernen', channels: ['manual:add', 'manual:remove'], kind: 'auto',
    run: async (ctx) => {
      const name = `Ludora-Funktionstest ${Date.now()}`;
      const exe = window.gamehub?.platform === 'win32' ? 'C:\\Windows\\System32\\notepad.exe' : '/bin/sh';
      okRes(await call('manual:add', { name, exe, args: '' }), 'Hinzufügen');
      const r = await call('library:scan');
      const g = r.games.find((x) => x.name === name);
      if (!g) return fail('nach dem Hinzufügen nicht in der Bibliothek');
      okRes(await call('manual:remove', g.id), 'Entfernen');
      const r2 = await call('library:scan');
      ctx.scan = r2;
      return r2.games.some((x) => x.name === name) ? fail('nach dem Entfernen noch da') : ok('hinzugefügt, gefunden, entfernt');
    } },
  { id: 'pickExe', group: 'Bibliothek', name: 'Programm auswählen (Dialog)', channels: ['manual:pickExe'], kind: 'manual',
    run: async () => { const r = await call('manual:pickExe'); return r ? ok(r) : warn('abgebrochen'); } },
  { id: 'launch', group: 'Spiel', name: 'Spiel starten', channels: ['game:launch'], kind: 'manual', needs: 'game',
    run: async (ctx, p) => { okRes(await call('game:launch', p.game), 'Start'); return ok('gestartet – läuft es?'); } },
  { id: 'focus', group: 'Spiel', name: 'Laufendes Spiel nach vorne holen', channels: ['game:focus'], kind: 'manual', needs: 'game',
    run: async (ctx, p) => { const r = await call('game:focus', p.game); return r?.ok ? ok('nach vorne geholt') : warn('Spiel läuft nicht'); } },
  { id: 'update', group: 'Spiel', name: 'Update / Installation starten', channels: ['game:update'], kind: 'manual', needs: 'game',
    run: async (ctx, p) => { const r = okRes(await call('game:update', p.game, false), 'Update'); return ok(r.message || 'Auftrag gegeben – Downloads beobachten'); } },
  { id: 'manage', group: 'Spiel', name: 'Download pausieren/fortsetzen', channels: ['download:manage'], kind: 'manual', needs: 'game',
    run: async (ctx, p) => { const r = okRes(await call('download:manage', p.game), 'Download'); return ok(r.message || 'erledigt'); } },
  { id: 'setCover', group: 'Spiel', name: 'Eigenes Cover wählen', channels: ['game:setCover'], kind: 'manual', needs: 'game',
    run: async (ctx, p) => { const r = await call('game:setCover', p.game); return r?.ok ? ok('Cover gesetzt') : warn(r?.error || 'abgebrochen'); } },
  { id: 'openFolder', group: 'Spiel', name: 'Spielordner öffnen', channels: ['game:openFolder'], kind: 'manual', needs: 'game',
    run: async (ctx, p) => { okRes(await call('game:openFolder', p.game), 'Ordner'); return ok('geöffnet'); } },
  { id: 'stream', group: 'Spiel', name: 'Spiel streamen (Steam)', channels: ['game:stream'], kind: 'manual', needs: 'game',
    run: async (ctx, p) => { okRes(await call('game:stream', p.game), 'Streamen'); return ok('Steam übernimmt'); } },
  { id: 'uninstall', group: 'Spiel', name: 'Spiel deinstallieren (mit Rückfrage)', channels: ['game:uninstall'], kind: 'manual', needs: 'game', danger: true,
    run: async (ctx, p) => { const r = await call('game:uninstall', p.game); return r?.ok ? ok(r.message || 'deinstalliert') : warn(r?.error || 'abgebrochen'); } },
  { id: 'openLauncher', group: 'Spiel', name: 'Launcher öffnen', channels: ['launcher:open'], kind: 'manual', needs: 'launcher',
    run: async (ctx, p) => { okRes(await call('launcher:open', p.launcher, ''), 'Launcher'); return ok('geöffnet'); } },

  // ---------- Steam ----------
  { id: 'steamState', group: 'Steam', name: 'Steam-Anmeldung und Freunde', channels: ['friends:get'], kind: 'auto',
    run: async (ctx) => {
      const s = await call('friends:get'); ctx.steam = s;
      if (s.status === 'connected') {
        const on = (s.friends || []).filter((f) => f.state && f.state !== 'offline').length;
        return ok(`angemeldet, ${(s.friends || []).length} Freunde (${on} online)`);
      }
      return s.error ? fail(`${s.status}: ${s.error}`) : warn(`nicht angemeldet (${s.status})`);
    } },
  { id: 'steamFast', group: 'Steam', name: 'Schnelles Aktualisieren an/aus', channels: ['friends:fast'], kind: 'auto',
    run: async () => { await call('friends:fast', true); await call('friends:fast', false); return ok('umgeschaltet'); } },
  { id: 'steamAction', group: 'Steam', name: 'Freund-Aktion (ungültige ID wird abgelehnt)', channels: ['friends:action'], kind: 'auto',
    run: async () => { const r = await call('friends:action', '1', 'chat'); return r?.ok === false ? ok('ungültige ID abgelehnt') : fail('ungültige ID wurde angenommen'); } },
  { id: 'steamHistory', group: 'Steam', name: 'Chat-Verlauf laden', channels: ['chat:history'], kind: 'auto',
    run: async (ctx) => {
      const s = ctx.steam || await call('friends:get');
      if (s.status !== 'connected' || !s.friends?.length) return warn('übersprungen: Steam nicht angemeldet oder keine Freunde');
      const f = s.friends[0];
      const r = await call('chat:history', f.steamid);
      return r?.ok ? ok(`${r.messages.length} Nachrichten mit ${f.name}`) : fail(r?.error || 'Verlauf nicht geladen');
    } },
  { id: 'steamQr', group: 'Steam', name: 'Mit QR-Code anmelden', channels: ['friends:qr'], kind: 'manual',
    run: async () => { const r = await call('friends:qr'); return r?.qr || r?.ok ? ok('QR-Code erzeugt – in der Freundesliste scannen') : fail(r?.error || 'kein QR-Code'); } },
  { id: 'steamLogout', group: 'Steam', name: 'Bei Steam abmelden', channels: ['friends:logout'], kind: 'manual', danger: true,
    run: async () => { await call('friends:logout'); return ok('abgemeldet'); } },
  { id: 'friendsWindow', group: 'Freunde', name: 'Freundefenster öffnen', channels: ['friends:window'], kind: 'manual',
    run: async () => { okRes(await call('friends:window', 'all'), 'Freundefenster'); return ok('Fenster offen'); } },
  { id: 'friendsDock', group: 'Freunde', name: 'Freundesliste im Hauptfenster andocken', channels: ['friends:dock'], kind: 'manual',
    run: async () => { okRes(await call('friends:dock'), 'Andocken'); return ok('rechts im Hauptfenster angedockt'); } },
  { id: 'chatOpen', group: 'Steam', name: 'Chatfenster öffnen', channels: ['chat:open'], kind: 'manual', needs: 'friend',
    run: async (ctx, p) => { okRes(await call('chat:open', p.friend), 'Chat'); return ok('Fenster offen'); } },
  { id: 'chatSend', group: 'Steam', name: 'Nachricht senden', channels: ['chat:send'], kind: 'manual', needs: 'friend+text',
    run: async (ctx, p) => { okRes(await call('chat:send', p.friend, p.text), 'Senden'); return ok('gesendet'); } },
  { id: 'chatTyping', group: 'Steam', name: '„Schreibt gerade …“ senden', channels: ['chat:typing'], kind: 'manual', needs: 'friend',
    run: async (ctx, p) => { await call('chat:typing', p.friend); return ok('gesendet'); } },
  { id: 'chatRead', group: 'Steam', name: 'Als gelesen markieren', channels: ['chat:read'], kind: 'manual', needs: 'friend',
    run: async (ctx, p) => { await call('chat:read', p.friend); return ok('markiert'); } },

  // ---------- Weitere Freunde ----------
  { id: 'friends2', group: 'Weitere Freunde', name: 'Riot, Epic, GOG: Status', channels: ['friends2:list'], kind: 'auto',
    run: async (ctx) => {
      const r = await call('friends2:list'); ctx.friends2 = r;
      const parts = []; let worst = 'ok';
      for (const [id, s] of Object.entries(r || {})) {
        const n = (s.friends || []).length;
        if (s.status === 'connected') parts.push(`${id}: ${n} Freunde`);
        else if (s.status === 'error' || (s.error && s.status !== 'unavailable')) { parts.push(`${id}: FEHLER ${s.error}`); worst = 'fail'; }
        else { parts.push(`${id}: ${s.needsLogin ? 'nicht angemeldet' : s.reason || s.status}`); if (worst === 'ok') worst = 'warn'; }
      }
      return { status: worst, detail: parts.join(' · ') };
    } },
  { id: 'friends2Refresh', group: 'Weitere Freunde', name: 'Neu laden (Riot, Epic, GOG)', channels: ['friends2:refresh', 'friends2:fast'], kind: 'auto',
    run: async () => {
      for (const id of ['riot', 'epic', 'gog']) okRes(await call('friends2:refresh', id), id);
      await call('friends2:fast', true); await call('friends2:fast', false);
      return ok('angestoßen');
    } },
  { id: 'friends2Login', group: 'Weitere Freunde', name: 'Bei Epic / GOG anmelden', channels: ['friends2:login'], kind: 'manual', needs: 'launcher2',
    run: async (ctx, p) => { const r = await call('friends2:login', p.launcher2); return r?.ok ? ok('angemeldet') : warn(r?.error || 'abgebrochen'); } },
  { id: 'friends2Logout', group: 'Weitere Freunde', name: 'Bei Epic / GOG abmelden', channels: ['friends2:logout'], kind: 'manual', needs: 'launcher2', danger: true,
    run: async (ctx, p) => { okRes(await call('friends2:logout', p.launcher2), 'Abmelden'); return ok('abgemeldet'); } },
  { id: 'startRiot', group: 'Weitere Freunde', name: 'Riot Client im Hintergrund starten', channels: ['friends2:startRiot'], kind: 'manual',
    run: async () => { okRes(await call('friends2:startRiot'), 'Riot'); return ok('gestartet – Freundesliste sollte gleich laden'); } },
  { id: 'friends2Open', group: 'Weitere Freunde', name: 'Launcher öffnen (Freunde)', channels: ['friends2:open'], kind: 'manual', needs: 'launcher',
    run: async (ctx, p) => { const r = okRes(await call('friends2:open', p.launcher), 'Öffnen'); return ok(`${r.name} geöffnet`); } },
  { id: 'people', group: 'Weitere Freunde', name: 'Personen (Freunde zusammenfassen)', channels: ['people:get', 'people:save'], kind: 'auto',
    run: async () => {
      const before = await call('people:get');
      const after = await call('people:save', before);
      return JSON.stringify(after) === JSON.stringify(before) ? ok(`${before.length} Personen, Speichern klappt`) : fail('Speichern verändert die Liste');
    } },

  // ---------- Ludora-Konto ----------
  { id: 'hub', group: 'Ludora-Konto', name: 'Anmeldung und Server', channels: ['hub:get'], kind: 'auto',
    run: async (ctx) => {
      const h = await call('hub:get'); ctx.hub = h;
      if (!h.configured) return fail('Server nicht eingerichtet (src-tauri/hub-config.json fehlt)');
      if (h.status !== 'signedIn') return warn(h.error ? `nicht angemeldet: ${h.error}` : 'nicht angemeldet');
      const le = Object.entries(h.linkErrors || {}).map(([k, v]) => `${k}: ${v}`);
      if (h.error || h.friendsError || h.vaultError || le.length) return warn([h.error, h.friendsError, h.vaultError, ...le].filter(Boolean).join('; '));
      return ok(`angemeldet als ${h.user?.display_name || h.user?.username}, ${(h.links || []).length} verknüpfte Konten`);
    } },
  { id: 'hubFriends', group: 'Ludora-Konto', name: 'Ludora-Freunde laden', channels: ['hub:refreshFriends'], kind: 'auto',
    run: async (ctx) => {
      const h = ctx.hub || await call('hub:get');
      if (h.status !== 'signedIn') return warn('übersprungen: nicht angemeldet');
      await call('hub:refreshFriends');
      const h2 = await call('hub:get');
      return h2.friendsError ? fail(h2.friendsError) : ok(`${(h2.friends || []).length} Ludora-Freunde`);
    } },
  { id: 'hubLookup', group: 'Ludora-Konto', name: 'Launcher-Freunde mit Ludora abgleichen', channels: ['hub:lookup'], kind: 'auto',
    run: async (ctx) => {
      const h = ctx.hub || await call('hub:get');
      if (h.status !== 'signedIn') return warn('übersprungen: nicht angemeldet');
      const s = ctx.steam || await call('friends:get');
      const items = (s.friends || []).slice(0, 50).map((f) => ({ launcher: 'steam', account_id: f.steamid }));
      const r = await call('hub:lookup', items);
      return r?.ok ? ok(`${items.length} geprüft, ${r.items.length} nutzen Ludora`) : fail(r?.error || 'Abgleich fehlgeschlagen');
    } },
  { id: 'hubRelink', group: 'Ludora-Konto', name: 'Launcher-Konten neu verknüpfen', channels: ['hub:relink'], kind: 'manual',
    run: async () => { const r = await call('hub:relink'); const f = Object.entries(r?.failed || {}); return r?.error ? fail(r.error) : f.length ? fail(f.map(([l, e]) => `${l}: ${e}`).join('; ')) : r?.linked?.length ? ok(`verknüpft: ${r.linked.join(', ')}`) : warn('kein Launcher-Konto angemeldet'); } },
  { id: 'hubLogin', group: 'Ludora-Konto', name: 'Anmelden', channels: ['hub:login'], kind: 'manual', needs: 'name+password',
    run: async (ctx, p) => { const r = okRes(await call('hub:login', p.name, p.password), 'Anmelden'); return ok(r.restored?.length ? `wiederhergestellt: ${r.restored.join(', ')}` : 'angemeldet'); } },
  { id: 'hubRegister', group: 'Ludora-Konto', name: 'Registrieren', channels: ['hub:register'], kind: 'manual', needs: 'name+password',
    run: async (ctx, p) => { okRes(await call('hub:register', p.name, p.password), 'Registrieren'); return ok('Konto angelegt'); } },
  { id: 'hubLogout', group: 'Ludora-Konto', name: 'Abmelden', channels: ['hub:logout'], kind: 'manual', danger: true,
    run: async () => { await call('hub:logout'); return ok('abgemeldet'); } },
  { id: 'hubDelete', group: 'Ludora-Konto', name: 'Konto löschen (mit Rückfrage)', channels: ['hub:deleteAccount'], kind: 'manual', danger: true,
    run: async () => { const r = await call('hub:deleteAccount'); return r?.ok ? ok('gelöscht') : warn(r?.error || 'abgebrochen'); } },
  { id: 'hubFriendReq', group: 'Ludora-Konto', name: 'Freundschaftsanfrage senden', channels: ['hub:friendRequest'], kind: 'manual', needs: 'name',
    run: async (ctx, p) => { const r = await call('hub:friendRequest', p.name); return r?.ok ? ok(r.message) : warn(r?.error || r?.message); } },
  { id: 'hubFriendAccept', group: 'Ludora-Konto', name: 'Anfrage annehmen', channels: ['hub:friendAccept'], kind: 'manual', needs: 'name',
    run: async (ctx, p) => { okRes(await call('hub:friendAccept', p.name), 'Annehmen'); return ok('angenommen'); } },
  { id: 'hubFriendRemove', group: 'Ludora-Konto', name: 'Ludora-Freund entfernen', channels: ['hub:friendRemove'], kind: 'manual', needs: 'name', danger: true,
    run: async (ctx, p) => { okRes(await call('hub:friendRemove', p.name), 'Entfernen'); return ok('entfernt'); } },
  { id: 'hubUnlink', group: 'Ludora-Konto', name: 'Launcher-Konto trennen', channels: ['hub:unlink'], kind: 'manual', needs: 'link', danger: true,
    run: async (ctx, p) => { const [l, id] = p.link.split('|'); okRes(await call('hub:unlink', l, id), 'Trennen'); return ok('getrennt'); } },
  { id: 'hubSteamAdd', group: 'Ludora-Konto', name: 'Als Steam-Freund hinzufügen', channels: ['hub:steamAdd'], kind: 'manual', needs: 'friend',
    run: async (ctx, p) => { okRes(await call('hub:steamAdd', p.friend), 'Steam'); return ok('Steam-Fenster sollte aufgehen'); } },

  // ---------- Shop ----------
  ...['steam', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'riot', 'rockstar'].map((store) => ({
    id: `shop-${store}`, group: 'Shop', name: `Shop: ${store}`, channels: ['shop:query'], kind: 'auto',
    run: async () => {
      const r = await call('shop:query', { store, page: 0 });
      if (!r?.ok) return fail(r?.error || 'keine Antwort');
      const errs = Object.entries(r.errors || {}).map(([k, v]) => `${k}: ${v}`);
      if (!r.games.length) return errs.length ? fail(errs.join('; ')) : warn('keine Spiele');
      const withPrice = r.games.filter((g) => g.minPrice != null).length;
      return errs.length ? warn(`${r.games.length} Spiele, aber: ${errs.join('; ')}`) : ok(`${r.games.length} Spiele, ${withPrice} mit Preis`);
    }
  })),
  { id: 'shopAll', group: 'Shop', name: 'Shop: Suche in allen Stores', channels: ['shop:query'], kind: 'auto',
    run: async () => {
      const r = await call('shop:query', { q: 'portal', page: 0 });
      if (!r?.ok) return fail(r?.error || 'keine Antwort');
      const errs = Object.entries(r.errors || {}).map(([k, v]) => `${k}: ${v}`);
      return errs.length ? warn(`${r.games.length} Treffer, aber: ${errs.join('; ')}`) : ok(`${r.games.length} Treffer für „portal“`);
    } },
  { id: 'shopMore', group: 'Shop', name: 'Shop: weitere Stores nachladen', channels: ['shop:more'], kind: 'auto',
    run: async () => { const r = await call('shop:more', ['Battlefield 1', 'Assassin\'s Creed Valhalla']); return r?.ok ? ok(`${Object.keys(r.stores).length} Spiele mit weiteren Stores`) : warn(r?.error || 'keine Antwort'); } },
  { id: 'shopOpen', group: 'Shop', name: 'Shop: Store-Seite öffnen', channels: ['shop:open'], kind: 'manual',
    run: async () => { const r = okRes(await call('shop:open', { launcher: 'steam', url: 'https://store.steampowered.com/app/620/', uri: 'steam://store/620' }), 'Öffnen'); return ok(`geöffnet über ${r.via}`); } },

  // ---------- Updates ----------
  { id: 'updateGet', group: 'Ludora-Updates', name: 'Update-Status', channels: ['update:get'], kind: 'auto',
    run: async () => { const r = await call('update:get'); return r?.current ? ok(`Version ${r.current}, Status ${r.status}`) : fail('kein Status'); } },
  { id: 'updateCheck', group: 'Ludora-Updates', name: 'Nach Updates suchen', channels: ['update:check'], kind: 'auto',
    run: async () => {
      const r = await call('update:check');
      if (r.error) return fail(r.error);
      return ok(r.status === 'available' ? `Update ${r.latest} verfügbar (signiert)` : `aktuell (neueste: ${r.latest || '–'})`);
    } },
  { id: 'updateInstall', group: 'Ludora-Updates', name: 'Update installieren', channels: ['update:install'], kind: 'manual', danger: true,
    run: async () => { const r = await call('update:install'); return r?.ok ? ok(r.page ? 'Testversion: Release-Seite geöffnet' : 'läuft') : warn(r?.error || 'kein Update verfügbar'); } }
];

/** Ereignisse, die die App schickt – der Debug-Bereich zählt mit */
export const EVENTS = ['friends:update', 'friends:tab', 'friends:hub', 'friends2:update', 'hub:update', 'chat:event', 'library:cover', 'library:compat',
  'library:streams', 'update:state', 'update:open', 'app:navigate'];

/** Einen Test ausführen (mit Zeitlimit) */
export async function runTest(t, ctx, params = {}) {
  const started = performance.now();
  try {
    const r = await Promise.race([
      t.run(ctx, params),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung (60 s)')), 60000))
    ]);
    return { ...r, ms: Math.round(performance.now() - started) };
  } catch (e) {
    return { status: 'fail', detail: errText(e), ms: Math.round(performance.now() - started) };
  }
}

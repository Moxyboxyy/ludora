// Riot-Freundesliste über die lokale Schnittstelle des Riot Client (kein Login nötig).
//
//   GET /chat/v4/friends    -> alle Freunde (Riot-ID, puuid)
//   GET /chat/v4/presences  -> wer gerade online ist: state (chat/away/dnd/mobile), product
//                              (league_of_legends, valorant, ...), private (Details, oft Base64-JSON)
// Port + Passwort stehen in %LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile – nur solange
// der Riot Client läuft. Ohne laufenden Client gibt es keine Liste.
const { t } = require('../i18n.js');
const { createStore } = require('./common');
const rc = require('../riotClient');

const store = createStore({ needsLogin: false });
let timer = null;
let fast = false;
const pidByPuuid = new Map(); // puuid -> pid ("puuid@eu1.pvp.net") = Gesprächs-ID für Direktnachrichten
const chatListeners = new Set();
const watched = new Map();    // puuid -> Anzahl offener Chatfenster
const lastSeen = new Map();   // cid -> Zeit der neuesten bekannten Nachricht
let myPuuid = null;
let chatTimer = null;

const PRODUCTS = {
  league_of_legends: 'League of Legends',
  valorant: 'VALORANT',
  bacon: 'Legends of Runeterra',
  lion: '2XKO',
  teamfighttactics: 'Teamfight Tactics'
};
// "mobile" = nur in der Riot-/League-Handy-App: zeigt auch der Riot Client als offline
const STATES = { chat: 'online', away: 'away', dnd: 'busy', mobile: 'offline', offline: 'offline', unavailable: 'offline' };
// Kein echtes Spiel – nur der Client selbst
const NOT_A_GAME = new Set(['', 'keystone', 'riot_client', 'riotclient', 'rso']);

// Spielphase verständlich machen
const LOL_STATUS = {
  outOfGame: 'Im Client', inQueue: 'In der Warteschlange', championSelect: 'Champion-Auswahl',
  inGame: 'Im Spiel', hosting_NORMAL: 'Erstellt eine Lobby', hosting_RANKED_SOLO_5x5: 'Erstellt eine Lobby',
  spectating: 'Schaut zu'
};
const VAL_STATUS = { MENUS: 'Im Menü', PREGAME: 'Agenten-Auswahl', INGAME: 'Im Spiel' };

function decodePrivate(p) {
  if (!p) return null;
  for (const t of [() => JSON.parse(Buffer.from(p, 'base64').toString('utf8')), () => JSON.parse(p)]) {
    try { const j = t(); if (j && typeof j === 'object') return j; } catch { /* nächste Variante */ }
  }
  return null;
}

const VAL_QUEUE = {
  competitive: 'Competitive', unrated: 'Unrated', swiftplay: 'Swiftplay', spikerush: 'Spike Rush', deathmatch: 'Deathmatch',
  ggteam: 'Escalation', onefa: 'Replication', hurm: 'Team Deathmatch', premier: 'Premier', newmap: 'New Map'
};

/** Text zur Spielphase (VALORANT: Modus + Spielstand, LoL/TFT: Phase) */
function richTextFor(product, priv) {
  if (!priv) return null;
  if (product === 'valorant') {
    // neues Format: matchPresenceData / partyPresenceData, altes: alles flach
    const m = priv.matchPresenceData || priv;
    const party = priv.partyPresenceData || priv;
    const loop = m.sessionLoopState || priv.sessionLoopState;
    const q = String(m.queueId || priv.queueId || party.queueId || '').toLowerCase();
    const mode = VAL_QUEUE[q] || (q ? q[0].toUpperCase() + q.slice(1) : '');
    if (loop === 'INGAME') {
      const ally = party.partyOwnerMatchScoreAllyTeam ?? priv.partyOwnerMatchScoreAllyTeam;
      const enemy = party.partyOwnerMatchScoreEnemyTeam ?? priv.partyOwnerMatchScoreEnemyTeam;
      const score = Number.isFinite(Number(ally)) && Number.isFinite(Number(enemy)) ? `${ally} - ${enemy}` : '';
      return [mode || t("Im Spiel"), score].filter(Boolean).join(' ');
    }
    const base = VAL_STATUS[loop] ? t(VAL_STATUS[loop]) : null;
    return [base, mode].filter(Boolean).join(' · ') || null;
  }
  if (product === 'league_of_legends' || product === 'teamfighttactics') {
    return LOL_STATUS[priv.gameStatus] ? t(LOL_STATUS[priv.gameStatus]) : (priv.gameStatus ? String(priv.gameStatus) : null);
  }
  return null;
}

/** Wie "gut" ist eine Presence? Echtes Spiel vor Client, online vor abwesend */
function score(p) {
  const st = STATES[p.state] || 'online';
  if (st === 'offline') return 0;
  const game = !NOT_A_GAME.has(String(p.product || '').toLowerCase());
  return (game ? 10 : 0) + (st === 'online' ? 3 : st === 'busy' ? 2 : 1);
}

/** Freunde + Presences -> einheitliches Format (für Tests getrennt) */
function merge(friends, presences) {
  // Pro Freund kann es mehrere Presences geben (Riot Client + Spiel + Handy) -> die beste nehmen
  const pres = new Map();
  for (const p of presences || []) {
    if (!p?.puuid) continue;
    const cur = pres.get(p.puuid);
    if (!cur || score(p) > score(cur)) pres.set(p.puuid, p);
  }
  return (friends || []).map((f) => {
    const p = pres.get(f.puuid);
    const state = p ? (STATES[p.state] || 'online') : 'offline';
    const online = state !== 'offline';
    const prodRaw = String(p?.product || '').toLowerCase();
    const product = online && !NOT_A_GAME.has(prodRaw) ? prodRaw : null;
    const name = f.game_name || f.name || p?.game_name || 'Unbekannt';
    const tag = f.game_tag || p?.game_tag || '';
    return {
      id: f.puuid,
      name,
      tag,
      avatar: null,
      state,
      gameName: product ? (PRODUCTS[product] || product) : null,
      richText: product ? richTextFor(product, decodePrivate(p?.private)) : null,
      lastOnline: null
    };
  });
}

async function poll() {
  clearTimeout(timer);
  try {
    if (!rc.hasApi()) {
      store.set({ status: 'unavailable', reason: 'notRunning', error: null, friends: [] });
      return;
    }
    const [fr, pr] = await Promise.all([rc.api('GET', '/chat/v4/friends'), rc.api('GET', '/chat/v4/presences')]);
    // 404: Der Riot Client läuft nur im Hintergrundmodus (nur Updates) – sein Chat-Modul ist dann aus.
    // 0: Riot Client gerade beendet (lockfile noch da)
    if (fr.status === 404 || fr.status === 0) {
      store.set({ status: 'unavailable', reason: fr.status === 404 ? 'chatOff' : 'notRunning', error: null, friends: [] });
      return;
    }
    if (fr.status !== 200) throw new Error(t("Riot Client antwortet mit {0}", [fr.status]));
    const friends = JSON.parse(fr.body || '{}').friends || [];
    for (const f of friends) if (f.puuid && f.pid) pidByPuuid.set(f.puuid, f.pid);
    const presences = pr.status === 200 ? JSON.parse(pr.body || '{}').presences || [] : [];
    store.set({ status: 'connected', error: null, hint: null, friends: merge(friends, presences) });
  } catch (err) {
    store.set({ status: 'error', error: err.message });
  } finally {
    timer = setTimeout(poll, fast ? 3000 : 10000);
  }
}

// ---------- Chat ----------

async function me() {
  if (myPuuid) return myPuuid;
  const r = await rc.api('GET', '/chat/v1/session');
  if (r.status === 200) myPuuid = JSON.parse(r.body || '{}').puuid || null;
  return myPuuid;
}

function chatError(status) {
  if (status === 404) return new Error(t("Der Riot-Chat ist gerade aus (Riot Client läuft nur im Hintergrund). Öffne den Riot Client einmal normal."));
  if (status === 0) return new Error(t("Der Riot Client läuft nicht."));
  return new Error(t("Riot Client antwortet mit {0}", [status]));
}

function cidFor(puuid) {
  const cid = pidByPuuid.get(puuid);
  if (!cid) throw new Error(t("Riot-Freund nicht gefunden – Freundesliste neu laden."));
  return cid;
}

/** Nachrichten eines Gesprächs -> einheitliches Format (für Tests getrennt) */
function toMessages(list, mine) {
  return (list || []).filter((m) => m && (m.type === 'chat' || !m.type) && m.body).map((m) => ({
    fromMe: !!mine && (m.puuid === mine || String(m.pid || '').startsWith(`${mine}@`)),
    text: m.body,
    ts: Number(m.time) || Date.parse(m.time) || Date.now(),
    id: m.id || m.mid
  })).sort((a, b) => a.ts - b.ts);
}

async function history(puuid) {
  const cid = cidFor(puuid);
  const r = await rc.api('GET', `/chat/v6/messages?cid=${encodeURIComponent(cid)}`);
  if (r.status !== 200) throw chatError(r.status);
  const msgs = toMessages(JSON.parse(r.body || '{}').messages, await me());
  if (msgs.length) lastSeen.set(cid, Math.max(lastSeen.get(cid) || 0, msgs[msgs.length - 1].ts));
  return msgs;
}

async function send(puuid, text) {
  const cid = cidFor(puuid);
  const r = await rc.api('POST', '/chat/v6/messages', { cid, message: String(text).slice(0, 2000), type: 'chat' });
  if (r.status < 200 || r.status >= 300) throw chatError(r.status);
  setTimeout(checkChats, 400); // eigene Nachricht gleich anzeigen
}

function emitChat(ev) { for (const l of chatListeners) { try { l(ev); } catch { /* egal */ } } }

/** Neue Nachrichten suchen: offene Chats alle 2 s, sonst alle 8 s über die Ungelesen-Zähler */
async function checkChats() {
  clearTimeout(chatTimer);
  try {
    if (!rc.hasApi()) return;
    const mine = await me();
    const cids = new Set([...watched.keys()].map((p) => pidByPuuid.get(p)).filter(Boolean));
    const cr = await rc.api('GET', '/chat/v6/conversations');
    if (cr.status === 200) {
      for (const c of JSON.parse(cr.body || '{}').conversations || []) {
        if (c.type === 'chat' && Number(c.unread_count) > 0) cids.add(c.cid);
      }
    }
    for (const cid of cids) {
      const r = await rc.api('GET', `/chat/v6/messages?cid=${encodeURIComponent(cid)}`);
      if (r.status !== 200) continue;
      const msgs = toMessages(JSON.parse(r.body || '{}').messages, mine);
      const known = lastSeen.get(cid);
      const newest = msgs.length ? msgs[msgs.length - 1].ts : 0;
      if (known === undefined) { lastSeen.set(cid, newest); continue; } // erstes Mal: nur merken
      const puuid = cid.split('@')[0];
      for (const m of msgs) if (m.ts > known) emitChat({ type: 'message', steamid: `riot:${puuid}`, ...m });
      lastSeen.set(cid, Math.max(known, newest));
    }
  } catch { /* nächster Durchlauf */ } finally {
    chatTimer = setTimeout(checkChats, watched.size ? 2000 : 8000);
    chatTimer.unref?.();
  }
}

function watch(puuid, on) {
  const n = (watched.get(puuid) || 0) + (on ? 1 : -1);
  if (n > 0) watched.set(puuid, n); else watched.delete(puuid);
  if (on) checkChats();
}

module.exports = {
  id: 'riot',
  chat: { history, send, watch, onChat(fn) { chatListeners.add(fn); return () => chatListeners.delete(fn); }, start: checkChats },
  _toMessages: toMessages,
  // Riot gibt nur lokale Daten heraus -> Verknüpfung "nicht bestätigt"
  async getLinkProof() {
    if (!rc.hasApi()) return null;
    const r = await rc.api('GET', '/chat/v1/session');
    if (r.status !== 200) return null;
    const j = JSON.parse(r.body || '{}');
    return j.puuid ? { token: '', claim: { puuid: j.puuid, game_name: j.game_name, game_tag: j.game_tag }, accountId: j.puuid } : null;
  },
  name: 'Riot',
  getState: store.get,
  onChange: store.on,
  init() { poll(); },
  refresh: poll,
  setFast(on) { fast = !!on; if (on) poll(); },
  _merge: merge
};

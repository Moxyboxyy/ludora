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

const PRODUCTS = {
  league_of_legends: 'League of Legends',
  valorant: 'VALORANT',
  bacon: 'Legends of Runeterra',
  lion: '2XKO',
  teamfighttactics: 'Teamfight Tactics'
};
const STATES = { chat: 'online', away: 'away', dnd: 'busy', mobile: 'away', offline: 'offline' };

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

/** Freunde + Presences -> einheitliches Format (für Tests getrennt) */
function merge(friends, presences) {
  const pres = new Map();
  for (const p of presences || []) if (p?.puuid) pres.set(p.puuid, p);
  return (friends || []).map((f) => {
    const p = pres.get(f.puuid);
    const priv = decodePrivate(p?.private);
    const product = p?.product && p.product !== 'keystone' ? p.product : null;
    let richText = null;
    if (priv) {
      if (product === 'valorant') richText = VAL_STATUS[priv.sessionLoopState] ? t(VAL_STATUS[priv.sessionLoopState]) : null;
      else if (product === 'league_of_legends' || product === 'teamfighttactics') {
        richText = LOL_STATUS[priv.gameStatus] ? t(LOL_STATUS[priv.gameStatus]) : (priv.gameStatus ? String(priv.gameStatus) : null);
      }
    }
    const name = f.game_name || f.name || p?.game_name || 'Unbekannt';
    const tag = f.game_tag || p?.game_tag || '';
    return {
      id: f.puuid,
      name,
      tag,
      avatar: null,
      state: p ? (STATES[p.state] || 'online') : 'offline',
      gameName: product ? (PRODUCTS[product] || product) : null,
      richText,
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
    const presences = pr.status === 200 ? JSON.parse(pr.body || '{}').presences || [] : [];
    store.set({ status: 'connected', error: null, hint: null, friends: merge(friends, presences) });
  } catch (err) {
    store.set({ status: 'error', error: err.message });
  } finally {
    timer = setTimeout(poll, fast ? 3000 : 10000);
  }
}

module.exports = {
  id: 'riot',
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

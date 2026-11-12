import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { UsersIcon, PlayIcon, LauncherLogo, UserAddIcon, UserCopyIcon } from './bits.jsx';
import { t } from '../i18n.js';
import { useExit } from '../useExit.js';
import WindowControls from './WindowControls.jsx';

// Freundefenster: eigene Fensterleiste (wie TitleBar.jsx)
const FW_PLATFORM = api.platform || 'demo';
const FW_OWN_CONTROLS = api.runtime === 'tauri' && FW_PLATFORM !== 'darwin';

const STATE_LABEL = { online: t("Online"), away: t("Abwesend"), snooze: t("Abwesend"), busy: t("Beschäftigt"), offline: t("Offline") };
const LAUNCHERS = [
  ['steam', 'Steam'],
  ['riot', 'Riot'],
  ['epic', 'Epic'],
  ['gog', 'GOG']
];
const LAUNCHER_NAME = Object.fromEntries(LAUNCHERS);

function ago(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 60) return t("vor {0} Min.", [min]);
  const h = Math.round(min / 60);
  if (h < 48) return t("vor {0} Std.", [h]);
  return t("vor {0} Tagen", [Math.round(h / 24)]);
}

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function savePref(key, v) {
  try { localStorage.setItem(key, v); } catch { /* egal */ }
}

/** Status eines Kontos als Rang (für Sortierung und "bester Status" einer Person) */
const CHAT_LAUNCHERS = new Set(['riot', 'epic']);
const rank = (a) => (a.state === 'offline' ? 0 : a.gameName ? 4 : a.state === 'online' ? 3 : a.state === 'busy' ? 2.5 : 2);
const cls = (a) => (a.state !== 'offline' && a.gameName ? 'ingame' : a.state);
const norm = (s) => String(s || '').toLowerCase().replace(/#.*$/, '').replace(/[^a-z0-9äöüß]/g, '');

function statusText(a) {
  if (a.state !== 'offline' && a.gameName) return <>{a.gameName}{a.richText ? <span className="rp"> · {a.richText}</span> : null}</>;
  if (a.state === 'offline') return a.lastOnline ? t("Zuletzt online {0}", [ago(a.lastOnline)]) : t("Offline");
  return a.richText && a.launcher !== 'steam' ? `${STATE_LABEL[a.state] || t("Online")} · ${a.richText}` : STATE_LABEL[a.state] || t("Online");
}

function Avatar({ a, name }) {
  const [ok, setOk] = useState(true);
  const n = name || a.name || '?';
  return (
    <span className={`avatar ${cls(a)}`}>
      {a.avatar && ok ? <img src={a.avatar} alt="" onError={() => setOk(false)} /> : <span>{n.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

/** Steam-Freund -> einheitliches Konto */
function fromSteam(f) {
  return {
    key: `steam:${f.steamid}`, launcher: 'steam', id: f.steamid, name: f.name, avatar: f.avatar,
    state: f.state, gameName: f.appid ? (f.gameName || t("Im Spiel")) : null, richText: f.richText,
    lastOnline: f.lastOnline, joinable: f.joinable, appid: f.appid, unread: f.unread, raw: f
  };
}
function fromOther(launcher, f) {
  return { ...f, key: `${launcher}:${f.id}`, launcher, name: f.tag ? `${f.name}#${f.tag}` : f.name, shortName: f.name };
}

/** "Aktualisiert vor 3 s" – zeigt, wie frisch die Liste ist */
function Freshness({ at, label }) {
  const [, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(timer); }, []);
  const sec = at ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null;
  const age = sec === null ? '' : sec < 60 ? t("vor {0} s", [sec]) : t("vor {0} Min.", [Math.round(sec / 60)]);
  return <span className={`muted small freshness ${sec !== null && sec > 90 ? 'stale' : ''}`}>{label}{age ? ` · ${t("aktualisiert {0}", [age])}` : ''}</span>;
}

/** Freundesliste im eigenen Freundefenster (#friends=<liste>, siehe FriendsWindow.jsx) */
export default function FriendsPanel({ games, onLaunchGame, notify, providerById = {}, hubRequest = 0, initialTab = null }) {
  const [steam, setSteam] = useState({ status: 'disconnected', friends: [] });
  const [others, setOthers] = useState({});
  const [people, setPeople] = useState([]);
  const [tab, setTab] = useState(() => initialTab || loadPref('friendsTab', 'all'));
  const [switcher, setSwitcher] = useState(false); // Freundefenster: Auswahl der Liste (Klick auf die Leiste)
  const [switcherShown, switcherClosing] = useExit(switcher, 300);
  // Freundefenster: Hauptfenster hat eine andere Liste gewählt
  useEffect(() => api.friendsWindow?.onTab?.((id) => { setTab(id); setSwitcher(false); }), []);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(null);      // { a, person, x, y }
  const [assign, setAssign] = useState(null);  // Konto, das einer Person zugeordnet wird
  const [expanded, setExpanded] = useState(() => new Set());
  const [showOffline, setShowOffline] = useState(false);
  const panelRef = useRef(null);
  const [hub, setHub] = useState({ status: 'signedOut', configured: false, links: [] });
  const [hubOpen, setHubOpen] = useState(false);
  useEffect(() => { if (hubRequest) setHubOpen(true); }, [hubRequest]);
  const [hubMap, setHubMap] = useState(() => new Map()); // "steam:7656…" -> { username, display_name, verified }

  useEffect(() => {
    api.friends.get().then(setSteam);
    const offSteam = api.friends.onUpdate(setSteam);
    api.friends2.list().then(setOthers);
    const offOthers = api.friends2.onUpdate(({ id, state }) => setOthers((o) => ({ ...o, [id]: state })));
    api.people.get().then(setPeople);
    api.hub.get().then(setHub);
    const offHub = api.hub.onUpdate(setHub);
    return () => { offSteam(); offOthers(); offHub(); };
  }, []);

  // Solange das Freundefenster offen ist, öfter aktualisieren
  useEffect(() => {
    api.friends.fast(true); api.friends2.fast(true);
    return () => { api.friends.fast(false); api.friends2.fast(false); };
  }, []);
  useEffect(() => savePref('friendsTab', tab), [tab]);
  useEffect(() => {
    if (!switcher) return undefined;
    // Klicks außerhalb der Leiste schließen die Auswahl. Erst im nächsten Durchlauf anmelden: React führt diesen Effekt
    // noch während des Klicks aus, der die Auswahl geöffnet hat – sonst schlösse genau dieser Klick sie gleich wieder.
    const close = (e) => { if (!(e.target instanceof Element && e.target.closest('.fw-current, .fw-switcher'))) setSwitcher(false); };
    const key = (e) => { if (e.key === 'Escape') setSwitcher(false); };
    const timer = setTimeout(() => { window.addEventListener('click', close); window.addEventListener('keydown', key); }, 0);
    return () => { clearTimeout(timer); window.removeEventListener('click', close); window.removeEventListener('keydown', key); };
  }, [switcher]);

  // Alle Konten aller Launcher im gleichen Format
  const accounts = useMemo(() => {
    const list = [];
    if (steam.status === 'connected') for (const f of steam.friends) list.push(fromSteam(f));
    for (const [launcher] of LAUNCHERS.slice(1)) {
      const st = others[launcher];
      if (st?.status === 'connected') for (const f of st.friends || []) list.push(fromOther(launcher, f));
    }
    return list;
  }, [steam, others]);
  const byKey = useMemo(() => new Map(accounts.map((a) => [a.key, a])), [accounts]);
  const accountKeys = useMemo(() => accounts.map((a) => a.key).sort().join('|'), [accounts]);
  useEffect(() => {
    if (hub.status !== 'signedIn' || !accountKeys) { setHubMap(new Map()); return; }
    const timer = setTimeout(async () => {
      const items = accountKeys.split('|').map((k) => { const i = k.indexOf(':'); return { launcher: k.slice(0, i), account_id: k.slice(i + 1) }; });
      const r = await api.hub.lookup(items);
      if (r.ok) setHubMap(new Map(r.items.map((x) => [`${x.launcher}:${x.account_id}`, x])));
    }, 600);
    return () => clearTimeout(timer);
  }, [accountKeys, hub.status]);
  const localPersonOf = useMemo(() => {
    const m = new Map();
    for (const p of people) for (const mem of p.members) m.set(`${mem.launcher}:${mem.id}`, p);
    return m;
  }, [people]);
  // Ludora-Nutzer: alle ihre Konten aus meiner Freundesliste unter ihrem Ludora-Namen
  const hubPeople = useMemo(() => {
    const groups = new Map();
    for (const [key, info] of hubMap) {
      if (localPersonOf.has(key) || !byKey.has(key)) continue;
      const g = groups.get(info.username) || { id: `hub:${info.username}`, name: info.display_name || info.username, hub: true, members: [], unverified: new Set() };
      const i = key.indexOf(':');
      g.members.push({ launcher: key.slice(0, i), id: key.slice(i + 1) });
      if (!info.verified) g.unverified.add(key);
      groups.set(info.username, g);
    }
    return [...groups.values()];
  }, [hubMap, localPersonOf, byKey]);
  const personOf = useMemo(() => {
    const m = new Map(localPersonOf);
    for (const p of hubPeople) for (const mem of p.members) m.set(`${mem.launcher}:${mem.id}`, p);
    return m;
  }, [localPersonOf, hubPeople]);
  // Ludora-Freunde (angenommen) – eigene Darstellung, auch ohne gemeinsame Launcher-Freundschaft
  const hubFriends = useMemo(() => (hub.status === 'signedIn' ? (hub.friends || []).filter((f) => f.relation === 'friend') : []), [hub]);
  const hubFriendNames = useMemo(() => new Set(hubFriends.map((f) => f.username)), [hubFriends]);
  const allPeople = useMemo(() => [...people, ...hubPeople.filter((p) => !hubFriendNames.has(p.id.slice(4)))], [people, hubPeople, hubFriendNames]);
  const hubFriendKeys = useMemo(() => {
    const m = new Map();
    for (const f of hubFriends) for (const a of f.accounts) m.set(`${a.launcher}:${a.account_id}`, f);
    return m;
  }, [hubFriends]);

  // Ungelesene Nachrichten je Launcher (für den Freunde-Knopf unten rechts)
  const unreadBy = useMemo(() => {
    const m = { total: 0 };
    for (const a of accounts) if (a.unread > 0) { m[a.launcher] = (m[a.launcher] || 0) + a.unread; m.total += a.unread; }
    return m;
  }, [accounts]);

  // Steam-Spiele aus der eigenen Bibliothek (für "Spiel starten")
  const ownedSteam = useMemo(() => {
    const m = new Map();
    for (const g of games) if (g.provider === 'steam') m.set(String(g.nativeId), g);
    return m;
  }, [games]);

  // Vorschläge: gleicher Name in mehreren Launchern, noch keiner Person zugeordnet
  const suggestions = useMemo(() => {
    const groups = new Map();
    for (const a of accounts) {
      if (personOf.has(a.key) || hubFriendKeys.has(a.key)) continue;
      const k = norm(a.shortName || a.name);
      if (k.length < 3) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
    return [...groups.values()]
      .filter((g) => new Set(g.map((a) => a.launcher)).size >= 2)
      .slice(0, 3);
  }, [accounts, personOf, hubFriendKeys]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close); };
  }, [menu]);


  // ---------- Personen speichern ----------
  async function savePeople(list) {
    setPeople(await api.people.save(list));
  }
  function addToPerson(a, personId, newName) {
    const without = people.map((p) => ({ ...p, members: p.members.filter((m) => `${m.launcher}:${m.id}` !== a.key) }));
    const member = { launcher: a.launcher, id: a.id };
    const list = personId
      ? without.map((p) => (p.id === personId ? { ...p, members: [...p.members, member] } : p))
      : [...without, { name: newName || a.shortName || a.name, members: [member] }];
    savePeople(list.filter((p) => p.members.length));
    setAssign(null);
  }
  function mergeSuggestion(group) {
    const name = group.find((a) => a.launcher === 'steam')?.name || group[0].shortName || group[0].name;
    savePeople([...people, { name, members: group.map((a) => ({ launcher: a.launcher, id: a.id })) }]);
    notify(t("{0} zusammengefasst ({1})", [name, group.map((a) => LAUNCHER_NAME[a.launcher]).join(', ')]));
  }
  function removeFromPerson(a) {
    savePeople(people.map((p) => ({ ...p, members: p.members.filter((m) => `${m.launcher}:${m.id}` !== a.key) })).filter((p) => p.members.length));
  }
  function renamePerson(p) {
    const name = window.prompt(t("Neuer Name"), p.name);
    if (name && name.trim()) savePeople(people.map((x) => (x.id === p.id ? { ...x, name: name.trim() } : x)));
  }
  function dissolvePerson(p) {
    savePeople(people.filter((x) => x.id !== p.id));
  }

  // ---------- Aktionen ----------
  async function steamAction(f, a) {
    setMenu(null);
    if (a === 'launch') {
      const g = ownedSteam.get(String(f.appid));
      if (g && g.status !== 'notInstalled') return onLaunchGame(g);
      if (g) { notify(t("{0} ist nicht installiert – Steam öffnet die Installation.", [f.gameName])); return onLaunchGame(g); }
      notify(t(
        "Du besitzt {0} nicht – Steam-Shop wird geöffnet.",
        [f.gameName || t("das Spiel")]
      ));
      return api.friends.action(f.steamid, 'store');
    }
    if (a === 'chat') return api.chat.open(f.steamid);
    if (a === 'steamchat') a = 'chat';
    const res = await api.friends.action(f.steamid, a);
    if (!res.ok) notify(res.error || t("Nicht möglich"), 'error');
    else if (a === 'join') notify(t("Steam tritt dem Spiel von {0} bei …", [f.name]));
  }
  // Chat in Ludora: Riot (lokal über den Riot Client) und Epic (live); GOG erlaubt Chat nur in GOG Galaxy
  function openChat(a) {
    setMenu(null);
    api.chat.open(`${a.launcher}:${a.id}`).then((r) => { if (!r?.ok) notify(t("Nicht möglich"), 'error'); });
  }
  async function openLauncher(a) {
    setMenu(null);
    const res = await api.friends2.open(a.launcher);
    if (res.ok) notify(t(
      "{0} geöffnet – dort kannst du {1} schreiben.",
      [res.name, a.shortName || a.name]
    ));
    else notify(res.error, 'error');
  }
  function copyId(a) {
    setMenu(null);
    navigator.clipboard?.writeText(a.name).then(() => notify(t("{0} kopiert", [a.name]))).catch(() => {});
  }

  function openMenu(e, a, person) {
    e.preventDefault();
    const rect = panelRef.current.getBoundingClientRect();
    setMenu({ a, person, x: Math.min(e.clientX - rect.left, rect.width - 240), y: Math.min(e.clientY - rect.top, rect.height - 260) });
  }

  // ---------- Darstellung ----------
  function AccountRow({ a, nested = false }) {
    const p = personOf.get(a.key);
    return (
      (<div className={`friend ${cls(a)} ${nested ? 'nested' : ''}`}
        onContextMenu={(e) => openMenu(e, a, p)}
        onDoubleClick={() => (a.launcher === 'steam' ? steamAction(a.raw, 'chat') : CHAT_LAUNCHERS.has(a.launcher) ? openChat(a) : openLauncher(a))}>
        {nested ? <span className="acc-logo" title={LAUNCHER_NAME[a.launcher]}><LauncherLogo provider={providerById[a.launcher]} /></span> : <Avatar a={a} />}
        <div className="friend-info">
          <div className="friend-name">
            {nested && p?.hub && p.unverified?.has(a.key) && <span className="unverified" title={t("Vom Besitzer angegeben, nicht von Riot bestätigt")}>?</span>}
            {a.name}
            {a.unread > 0 && <span className="unread">{a.unread}</span>}
          </div>
          <div className="friend-status">{statusText(a)}</div>
        </div>
        {!nested && tab === 'all' && <span className="acc-logo small"><LauncherLogo provider={providerById[a.launcher]} small /></span>}
        <div className="friend-actions">
          {a.launcher === 'steam' ? (
            <>
              {a.gameName && a.joinable && <button className="play small" onClick={() => steamAction(a.raw, 'join')}>{t("Beitreten")}</button>}
              {a.gameName && <button className="secondary small icon-only" title={t("Spiel starten")} onClick={() => steamAction(a.raw, 'launch')}><PlayIcon /></button>}
              <button className="secondary small" onClick={() => steamAction(a.raw, 'chat')}>{t("Chat")}</button>
            </>
          ) : (
            CHAT_LAUNCHERS.has(a.launcher)
              ? <button className="secondary small" onClick={() => openChat(a)}>{t("Chat")}</button>
              : <button className="secondary small" onClick={() => openLauncher(a)} title={t("In {0} schreiben", [LAUNCHER_NAME[a.launcher]])}>{t("Öffnen")}</button>
          )}
        </div>
      </div>)
    );
  }

  function PersonRow({ p }) {
    const members = p.members.map((m) => byKey.get(`${m.launcher}:${m.id}`)).filter(Boolean);
    const best = members.slice().sort((x, y) => rank(y) - rank(x))[0] || { state: 'offline' };
    const isOpen = expanded.has(p.id);
    const toggle = () => setExpanded((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; });
    const avatarFrom = members.find((m) => m.avatar) || best;
    return (
      (<div className="person">
        <div className={`friend person-row ${cls(best)}`} onClick={toggle} onContextMenu={(e) => openMenu(e, null, p)}>
          <Avatar a={{ ...best, avatar: avatarFrom.avatar }} name={p.name} />
          <div className="friend-info">
            <div className="friend-name">{p.name}{p.hub && <span className="hub-badge" title={t("Ludora-Konto – Konten automatisch erkannt")}>{t("Ludora")}</span>}{members.some((m) => m.unread) && <span className="unread">{members.reduce((n, m) => n + (m.unread || 0), 0)}</span>}</div>
            <div className="friend-status">{statusText(best)}</div>
          </div>
          <span className="person-logos">
            {members.map((m) => <span key={m.key} className={`acc-dot ${cls(m)}`} title={`${LAUNCHER_NAME[m.launcher]}: ${m.name}`}><LauncherLogo provider={providerById[m.launcher]} small /></span>)}
          </span>
          <span className={`chev ${isOpen ? 'open' : ''}`}>▸</span>
        </div>
        {isOpen && (
          <div className="person-members">
            {members.length ? members.map((m) => <AccountRow key={m.key} a={m} nested />)
              : <div className="drawer-empty small">{t("Keines der Konten ist gerade geladen.")}</div>}
          </div>
        )}
      </div>)
    );
  }

  function HubFriendRow({ f, best }) {
    const isOpen = expanded.has(`hub:${f.username}`);
    const toggle = () => setExpanded((s) => { const n = new Set(s); const k = `hub:${f.username}`; if (n.has(k)) n.delete(k); else n.add(k); return n; });
    const known = f.accounts.map((x) => byKey.get(`${x.launcher}:${x.account_id}`)).filter(Boolean);
    const avatarFrom = known.find((m) => m.avatar);
    return (
      (<div className="person">
        <div className={`friend person-row ${cls(best)}`} onClick={toggle} onContextMenu={(e) => { e.preventDefault(); const r = panelRef.current.getBoundingClientRect(); setMenu({ hubFriend: f, x: Math.min(e.clientX - r.left, r.width - 240), y: e.clientY - r.top }); }}>
          <Avatar a={{ ...best, avatar: avatarFrom?.avatar }} name={f.displayName} />
          <div className="friend-info">
            <div className="friend-name">{f.displayName}<span className="hub-badge">{t("Ludora")}</span></div>
            <div className="friend-status">
              {best.launcher ? <>{statusText(best)}<span className="rp"> · {LAUNCHER_NAME[best.launcher]}</span></>
                : best.state === 'online' ? t("Online in Ludora")
                : f.lastSeen ? t("Zuletzt in Ludora {0}", [ago(f.lastSeen)]) : t("Offline")}
            </div>
          </div>
          <span className="person-logos">
            {f.accounts.map((x) => {
              const a = byKey.get(`${x.launcher}:${x.account_id}`);
              return <span key={x.launcher + x.account_id} className={`acc-dot ${a ? cls(a) : 'offline'}`} title={`${LAUNCHER_NAME[x.launcher]}: ${x.account_name || x.account_id}`}><LauncherLogo provider={providerById[x.launcher]} small /></span>;
            })}
          </span>
          <span className={`chev ${isOpen ? 'open' : ''}`}>▸</span>
        </div>
        {isOpen && (
          <div className="person-members">
            {f.accounts.length === 0 && <div className="drawer-empty small">{t("{0} hat noch keine Konten verknüpft.", [f.displayName])}</div>}
            {f.accounts.map((x) => {
              const a = byKey.get(`${x.launcher}:${x.account_id}`);
              if (a) return <AccountRow key={a.key} a={a} nested />;
              // In meiner Launcher-Liste (noch) nicht befreundet
              const label = x.account_name || x.account_id;
              return (
                (<div key={x.launcher + x.account_id} className="friend nested offline">
                  <span className="acc-logo" title={LAUNCHER_NAME[x.launcher]}><LauncherLogo provider={providerById[x.launcher]} /></span>
                  <div className="friend-info">
                    <div className="friend-name">{label}{!x.verified && <span className="unverified" title={t("Vom Besitzer angegeben, nicht bestätigt")}>?</span>}</div>
                    <div className="friend-status">{t("Nicht in deiner {0}-Freundesliste", [LAUNCHER_NAME[x.launcher]])}</div>
                  </div>
                  <div className="friend-actions" style={{ opacity: 1 }}>
                    {x.launcher === 'steam'
                      ? <button className="icon-btn small" title={t("Bei Steam als Freund hinzufügen")} aria-label={t("Bei Steam als Freund hinzufügen")}
                          onClick={() => api.hub.steamAdd(x.account_id).then(() => notify(t("Steam öffnet die Freundschaftsanfrage an {0} …", [label])))}><UserAddIcon /></button>
                      : <button className="icon-btn small" title={t(
                      "{0} kopieren – dann in {1} als Freund hinzufügen",
                      [x.launcher === 'riot' ? 'Riot-ID' : t("Namen"), LAUNCHER_NAME[x.launcher]]
                    )} aria-label={t("{0} kopieren", [label])}
                          onClick={() => navigator.clipboard?.writeText(label).then(() => notify(t(
                            "{0} kopiert – in {1} als Freund hinzufügen",
                            [label, LAUNCHER_NAME[x.launcher]]
                          )))}><UserCopyIcon /></button>}
                  </div>
                </div>)
              );
            })}
          </div>
        )}
      </div>)
    );
  }

  // Einträge für den aktuellen Reiter
  const q = query.trim().toLowerCase();
  const match = (txt) => !q || String(txt || '').toLowerCase().includes(q);
  // Ludora-Freund: bester Status aus meinen Launcher-Listen, sonst "online in Ludora"
  function hubEntry(f) {
    const known = f.accounts.map((x) => byKey.get(`${x.launcher}:${x.account_id}`)).filter(Boolean);
    const bestKnown = known.slice().sort((x, y) => rank(y) - rank(x))[0];
    const best = bestKnown && rank(bestKnown) > 0 ? bestKnown
      : f.online ? { state: 'online', richText: 'Ludora', launcher: null } : { state: 'offline', lastOnline: f.lastSeen };
    return {
      kind: 'hubfriend', f, best, rank: rank(best), sortName: f.displayName,
      ok: match(f.displayName) || match(f.username) || f.accounts.some((x) => match(x.account_name))
    };
  }
  let entries; // [{ kind: 'person'|'account', rank, sortName, p?, a? }]
  if (tab === 'all') {
    const personEntries = allPeople.map((p) => {
      const members = p.members.map((m) => byKey.get(`${m.launcher}:${m.id}`)).filter(Boolean);
      const best = members.slice().sort((x, y) => rank(y) - rank(x))[0] || { state: 'offline' };
      return { kind: 'person', p, best, rank: rank(best), sortName: p.name, ok: match(p.name) || members.some((m) => match(m.name) || match(m.gameName)) };
    });
    const loose = accounts.filter((a) => !personOf.has(a.key) && !hubFriendKeys.has(a.key)).map((a) => ({ kind: 'account', a, best: a, rank: rank(a), sortName: a.shortName || a.name, ok: match(a.name) || match(a.gameName) }));
    entries = [...hubFriends.map(hubEntry), ...personEntries.filter((e) => !(e.p.members || []).some((m) => hubFriendKeys.has(`${m.launcher}:${m.id}`))), ...loose].filter((e) => e.ok);
  } else if (tab === 'hub') {
    entries = hubFriends.map(hubEntry).filter((e) => e.ok);
  } else {
    entries = accounts.filter((a) => a.launcher === tab && (match(a.name) || match(a.gameName)))
      .map((a) => ({ kind: 'account', a, best: a, rank: rank(a), sortName: a.shortName || a.name }));
  }
  const by = (x, y) => x.sortName.localeCompare(y.sortName, 'de', { sensitivity: 'base' });
  const groups = [
    [t("Im Spiel"), entries.filter((e) => e.rank === 4).sort(by)],
    [t("Online"), entries.filter((e) => e.rank === 3 || e.rank === 2.5).sort(by)],
    [t("Abwesend"), entries.filter((e) => e.rank === 2).sort(by)],
    [t("Offline"), entries.filter((e) => e.rank === 0).sort((x, y) => (y.best.lastOnline || 0) - (x.best.lastOnline || 0) || by(x, y))]
  ];

  // Anmelde-/Status-Bereich je Launcher
  function LauncherState({ id }) {
    if (id === 'steam') return <SteamLogin st={steam} setSt={setSteam} />;
    const st = others[id] || { status: 'disconnected', needsLogin: id !== 'riot' };
    if (st.status === 'connected') return null;
    if (id === 'riot' && st.status === 'unavailable') {
      return (
        (<div className="friends-login">
          <p>{st.reason === 'chatOff'
            ? t(
            "Der Riot Client läuft gerade nur im Hintergrund (für Updates) – dabei ist sein Chat und damit die Freundesliste aus."
          )
            : t(
            "Die Riot-Freundesliste kommt direkt vom Riot Client – der läuft gerade nicht."
          )}</p>
          <p className="small">{t(
            "Ludora startet ihn mit verstecktem Fenster. Wie beim normalen Öffnen erscheinst du dabei bei Riot online."
          )}</p>
          <button className="primary" onClick={() => api.friends2.startRiot().then((r) => notify(r.ok ? t("Riot Client wird im Hintergrund gestartet …") : r.error, r.ok ? 'info' : 'error'))}>{t("Riot Client im Hintergrund starten")}</button>
        </div>)
      );
    }
    if (st.needsLogin) {
      const name = LAUNCHER_NAME[id];
      return (
        (<div className="friends-login">
          <p>{t("Melde dich einmal über die echte {0}-Seite an, um deine {0}-Freunde zu sehen. Ludora sieht dabei kein Passwort.", [name])}</p>
          {id === 'epic' && <p className="small">{t(
            "Damit Epic den Status deiner Freunde schickt, erscheinst du dort solange als „Abwesend“."
          )}</p>}
          <button className="primary" onClick={() => api.friends2.login(id).then((r) => { if (!r.ok && r.error) notify(r.error, 'error'); })}>{t("Bei {0} anmelden", [name])}</button>
          {st.error && <p className="form-error">{st.error}</p>}
        </div>)
      );
    }
    if (st.status === 'connecting') return <div className="friends-login"><p><span className="loader small" /> {t("Verbinde mit {0} …", [LAUNCHER_NAME[id]])}</p></div>;
    return <div className="friends-login"><p className="form-error">{st.error || t("Nicht verfügbar")}</p><button className="secondary" onClick={() => api.friends2.refresh(id)}>{t("Erneut versuchen")}</button></div>;
  }

  const connectedOf = (id) => (id === 'steam' ? steam.status === 'connected' : others[id]?.status === 'connected');
  const incoming = hub.status === 'signedIn' ? (hub.friends || []).filter((f) => f.relation === 'incoming') : [];
  const outgoing = hub.status === 'signedIn' ? (hub.friends || []).filter((f) => f.relation === 'outgoing') : [];
  const showList = tab === 'all' ? accounts.length > 0 || people.length > 0 || hubFriends.length > 0
    : tab === 'hub' ? hub.status === 'signedIn' : connectedOf(tab);

  // Listen zum Umschalten (Freunde-Knopf im Hauptfenster und Leiste im Freundefenster)
  const lists = [
    ['all', t("Alle"), null],
    ['hub', t("Ludora"), { id: 'manual' }],
    ...LAUNCHERS.map(([id, name]) => [id, name, { id, name, ...(providerById[id] || {}) }])
  ];
  const current = lists.find((l) => l[0] === tab) || lists[0];
  const pickList = (id) => { setTab(id); setSwitcher(false); };

  return (
      <aside className="friends-window friends" ref={panelRef}>
          {/* Eigene Fensterleiste wie im Hauptfenster: ziehbar, Fensterknöpfe rechts (Windows/Linux) bzw. Ampel links (Mac) */}
          <header className={`fw-bar ${FW_PLATFORM} ${FW_OWN_CONTROLS ? 'own-controls' : ''}`} data-tauri-drag-region>
            <button className="fw-current" onClick={() => setSwitcher((v) => !v)} aria-expanded={switcher} aria-label={current[0] === 'all' ? t("Alle Freunde") : current[1]}
              title={current[0] === 'all' ? t("Alle Freunde") : current[1]}>
              <span className="fw-icon">{current[2] ? <LauncherLogo provider={current[2]} /> : <UsersIcon />}</span>
            </button>
            <div className="fw-drag" data-tauri-drag-region />
            <div className="head-actions">
              {api.friendsWindow?.dock && (
                <button className="icon-btn fw-dock" onClick={() => api.friendsWindow.dock()}
                  title={t("Im Hauptfenster andocken – oder das Fenster an den rechten Rand des Hauptfensters ziehen")} aria-label={t("Im Hauptfenster andocken")}>
                  <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16M8 12h4M10 10l2 2-2 2" /></svg>
                </button>
              )}
              <button className={`hub-btn ${hub.status === 'signedIn' ? 'on' : ''}`} onClick={() => setHubOpen(true)}
                title={t("Dein Ludora-Konto: Freunde mit Ludora erkennen deine Konten automatisch")}>
                {hub.status === 'signedIn' ? (hub.user?.display_name || t("Ludora-Konto")) : t("Ludora-Konto")}
              </button>
            </div>
            {FW_OWN_CONTROLS && <WindowControls />}
            {switcherShown && (
              <div className={`fw-switcher ${switcherClosing ? 'closing' : ''}`} role="menu" onClick={(e) => e.stopPropagation()}>
                {lists.map(([id, name, prov], i) => (
                  <button key={id} role="menuitem" className={`round-pick ${tab === id ? 'on' : ''}`} style={{ '--i': i }}
                    onClick={() => pickList(id)} title={name} aria-label={name}>
                    {prov ? <LauncherLogo provider={prov} dim={id !== 'all' && id !== 'hub' && !connectedOf(id)} /> : <UsersIcon />}
                    {(unreadBy[id] || (id === 'all' && unreadBy.total)) > 0 && <span className="fab-badge">{id === 'all' ? unreadBy.total : unreadBy[id]}</span>}
                  </button>
                ))}
              </div>
            )}
          </header>

        {tab !== 'all' && tab !== 'hub' && <LauncherState id={tab} />}
        {tab === 'hub' && (hub.status !== 'signedIn' ? (
          <div className="friends-login">
            <p>{t(
              "Mit einem Ludora-Konto kannst du Freunde direkt über ihren Ludora-Namen hinzufügen – egal, auf welchen Plattformen ihr befreundet seid."
            )}</p>
            <button className="primary" onClick={() => setHubOpen(true)}>{t("Ludora-Konto anmelden / erstellen")}</button>
          </div>
        ) : (
          <HubRequests incoming={incoming} outgoing={outgoing} notify={notify} error={hub.friendsError} />
        ))}
        {tab === 'all' && !accounts.length && !people.length && (
          <div className="drawer-empty">{t(
            "Noch keine Freundesliste verbunden. Wähle oben einen Launcher und melde dich an."
          )}</div>
        )}

        {showList && (
          <>
            <div className="search friends-search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input placeholder={t("Freunde oder Spiele suchen")} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>

            {tab === 'all' && suggestions.length > 0 && !q && (
              <div className="suggestions">
                {suggestions.map((g) => (
                  <div key={g.map((a) => a.key).join('|')} className="suggestion">
                    <span>{t("Gleiche Person?")} <b>{g.map((a) => `${a.shortName || a.name} (${LAUNCHER_NAME[a.launcher]})`).join(' + ')}</b></span>
                    <button className="secondary small" onClick={() => mergeSuggestion(g)}>{t("Zusammenfassen")}</button>
                  </div>
                ))}
              </div>
            )}

            <div className="friends-list">
              {groups.map(([title, list]) => {
                if (!list.length) return null;
                const offline = title === 'Offline';
                return (
                  <section key={title}>
                    <h3 className={offline ? 'clickable' : ''} onClick={offline ? () => setShowOffline(!showOffline) : undefined}>
                      {title} <span className="count">{list.length}</span>
                      {offline && <span className="chev">{showOffline ? '▾' : '▸'}</span>}
                    </h3>
                    {(!offline || showOffline) && list.map((e) => (e.kind === 'person'
                      ? <PersonRow key={`p:${e.p.id}`} p={e.p} />
                      : e.kind === 'hubfriend' ? <HubFriendRow key={`h:${e.f.username}`} f={e.f} best={e.best} />
                      : <AccountRow key={e.a.key} a={e.a} />))}
                  </section>
                );
              })}
              {!entries.length && <div className="drawer-empty">{q ? t("Nichts gefunden für „{0}“.", [query]) : tab === 'hub' ? t(
                "Noch keine Ludora-Freunde – füge oben jemanden über seinen Ludora-Namen hinzu."
              ) : t("Noch keine Freunde geladen …")}</div>}
            </div>
            <footer className="friends-foot">
              {tab === 'steam' && <>
                <Freshness at={steam.updatedAt} label={steam.live ? t("Live über Steam") : t("Alle 5 s über die Steam-Web-API")} />
                <button className="link" onClick={() => api.friends.action(steam.friends[0]?.steamid || '00000000000000000', 'friendsWindow')}>{t("Steam-Freundesfenster")}</button>
                <button className="link" onClick={() => api.friends.logout().then(() => api.friends.get().then(setSteam))}>{t("Abmelden")}</button>
              </>}
              {(tab === 'epic' || tab === 'gog') && <>
                <Freshness at={others[tab]?.updatedAt} label={tab === 'epic' ? t("Live über Epic") : t("Alle 5 s von GOG")} />
                <button className="link" onClick={() => api.friends2.logout(tab)}>{t("Abmelden")}</button>
              </>}
              {tab === 'riot' && <Freshness at={others.riot?.updatedAt} label={t("Live vom Riot Client auf deinem PC")} />}
              {tab === 'all' && <span className="muted small">{t("Rechtsklick auf einen Freund → „Zu Person hinzufügen“")}</span>}
              {tab === 'hub' && <Freshness at={hub.updatedAt} label={t("Online = Ludora ist offen")} />}
            </footer>
          </>
        )}

        {menu && (
          <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
            {menu.hubFriend ? (
              <>
                <div className="cm-title">{menu.hubFriend.displayName} · Ludora</div>
                <button onClick={() => { const n = menu.hubFriend.displayName; setMenu(null); if (window.confirm(t("Ludora-Freundschaft mit {0} beenden?", [n]))) api.hub.friendRemove(menu.hubFriend.username).then((r) => notify(r.ok ? `${n} entfernt` : r.error, r.ok ? 'info' : 'error')); }}>{t("Ludora-Freundschaft beenden")}</button>
              </>
            ) : menu.a ? (
              <>
                <div className="cm-title">{menu.a.name} · {LAUNCHER_NAME[menu.a.launcher]}</div>
                {menu.a.launcher === 'steam' ? (
                  <>
                    {menu.a.gameName && menu.a.joinable && <button onClick={() => steamAction(menu.a.raw, 'join')}>{t("Spiel beitreten")}</button>}
                    {menu.a.gameName && (
                      <button onClick={() => steamAction(menu.a.raw, 'launch')}>
                        {ownedSteam.has(String(menu.a.appid)) ? t("{0} starten", [menu.a.gameName]) : t("{0} im Shop ansehen", [menu.a.gameName])}
                      </button>
                    )}
                    <button onClick={() => steamAction(menu.a.raw, 'chat')}>{t("Chat öffnen")}</button>
                    <button onClick={() => steamAction(menu.a.raw, 'steamchat')}>{t("Im Steam-Chat öffnen")}</button>
                    <button onClick={() => steamAction(menu.a.raw, 'profile')}>{t("Profil anzeigen")}</button>
                  </>
                ) : (
                  <>
                    {CHAT_LAUNCHERS.has(menu.a.launcher) && <button onClick={() => openChat(menu.a)}>{t("Chat öffnen")}</button>}
                    <button onClick={() => openLauncher(menu.a)}>{t("In {0} schreiben", [LAUNCHER_NAME[menu.a.launcher]])}</button>
                    <button onClick={() => copyId(menu.a)}>{menu.a.launcher === 'riot' ? t("Riot-ID kopieren") : t("Namen kopieren")}</button>
                  </>
                )}
                <hr />
                <button onClick={() => { setAssign(menu.a); setMenu(null); }}>{menu.person ? t("Andere Person zuordnen …") : t("Zu Person hinzufügen …")}</button>
                {menu.person && !menu.person.hub && <button onClick={() => { removeFromPerson(menu.a); setMenu(null); }}>{t("Aus „{0}“ entfernen", [menu.person.name])}</button>}
              </>
            ) : (
              <>
                <div className="cm-title">{menu.person.name}{menu.person.hub ? ' · Ludora' : ''}</div>
                {menu.person.hub ? (
                  <div className="cm-note">{t("Automatisch erkannt: {0} hat diese Konten mit seinem Ludora-Konto verknüpft.", [menu.person.name])}</div>
                ) : (
                  <>
                    <button onClick={() => { renamePerson(menu.person); setMenu(null); }}>{t("Umbenennen …")}</button>
                    <button onClick={() => { dissolvePerson(menu.person); setMenu(null); }}>{t("Person auflösen")}</button>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {hubOpen && <HubDialog hub={hub} providerById={providerById} notify={notify} onClose={() => setHubOpen(false)}
          launcherState={(id) => (id === 'steam' ? steam : others[id] || { status: 'disconnected', needsLogin: id !== 'riot' })}
          onShowLauncher={(id) => { setTab(id); setHubOpen(false); }} />}

        {assign && (
          <AssignDialog a={assign} people={people} onCancel={() => setAssign(null)} onPick={(pid, name) => addToPerson(assign, pid, name)} />
        )}
      </aside>
  );
}

/** Steam: Anmeldung per QR-Code (wie bisher) */
function SteamLogin({ st, setSt }) {
  if (st.status === 'connected') return null;
  return (
    (<div className="friends-login">
      {st.status === 'qr' || st.status === 'qr-scanned' ? (
        <>
          <img className="qr" src={st.qr} alt={t("QR-Code für die Steam-Anmeldung")} />
          <p>{st.status === 'qr-scanned'
            ? t("Gescannt – jetzt in der Steam-App bestätigen.")
            : t("Öffne die Steam-App auf dem Handy → Steam Guard → „QR-Code scannen“.")}</p>
        </>
      ) : st.status === 'connecting' ? (
        <p><span className="loader small" /> {t("Verbinde mit Steam …")}</p>
      ) : (
        <>
          <p>{t(
            "Melde dich einmal mit der Steam-App an, um deine Freunde zu sehen. Ludora sieht dabei kein Passwort."
          )}</p>
          <button className="primary" onClick={() => api.friends.qr().then(setSt)}>{t("Mit QR-Code anmelden")}</button>
        </>
      )}
      {st.error && <p className="form-error">{st.error}</p>}
    </div>)
  );
}

/** Konto einer Person zuordnen: bestehende auswählen oder neue anlegen */
function AssignDialog({ a, people, onCancel, onPick }) {
  const [name, setName] = useState(a.shortName || a.name);
  return (
    (<div className="assign-backdrop" onMouseDown={onCancel}>
      <div className="assign" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t("„{0}“ ({1}) zuordnen", [a.name, LAUNCHER_NAME[a.launcher]])}</h3>
        {people.length > 0 && (
          <div className="assign-list">
            {people.map((p) => (
              <button key={p.id} className="assign-item" onClick={() => onPick(p.id)}>
                <b>{p.name}</b>
                <span className="muted small">{p.members.map((m) => LAUNCHER_NAME[m.launcher]).join(', ')}</span>
              </button>
            ))}
          </div>
        )}
        <form className="assign-new" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onPick(null, name.trim()); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Name der neuen Person")} autoFocus />
          <button className="primary" type="submit">{t("Neue Person")}</button>
        </form>
        <button className="link" onClick={onCancel}>{t("Abbrechen")}</button>
      </div>
    </div>)
  );
}

const RESTORED_NAME = { steamWebToken: 'Steam', friendsEpic: 'Epic', friendsGog: 'GOG' };

/** Mein Ludora-Konto: registrieren / anmelden / verknüpfte Konten */
function HubDialog({ hub, providerById, notify, onClose, launcherState = () => ({}), onShowLauncher = () => {} }) {
  // Einzelne Zeile: Konto verknüpfen bzw. vorher beim Launcher anmelden
  const [linking, setLinking] = useState(null);
  const linkOne = async (l) => {
    setLinking(l);
    try {
      const r = await api.hub.linkOne(l);
      if (r?.ok) notify(t("Verknüpft: {0}", [LAUNCHER_NAME[l]]));
      else notify(r?.error || t("Verknüpfen fehlgeschlagen"), 'error');
    } finally { setLinking(null); }
  };
  const signIn = async (l) => {
    if (l === 'steam') return onShowLauncher('steam'); // Steam: QR-Code bzw. Anmeldung im Reiter Steam
    if (l === 'riot') {
      const r = await api.friends2.startRiot();
      notify(r?.ok ? t("Riot Client wird im Hintergrund gestartet – danach wird automatisch verknüpft.") : r?.error || t("Nicht möglich"), r?.ok ? 'info' : 'error');
      return;
    }
    const r = await api.friends2.login(l);
    if (r && !r.ok && r.error) notify(r.error, 'error');
  };
  // „Alle neu verknüpfen“ im Ludora-Konto: Ergebnis als Meldung zeigen
  const [relinking, setRelinking] = useState(false);
  const relink = async () => {
    setRelinking(true);
    try {
      const r = await api.hub.relink();
      const names = (ids) => ids.map((id) => LAUNCHERS.find((l) => l[0] === id)?.[1] || id).join(', ');
      const failed = Object.keys(r?.failed || {});
      if (r?.error) notify(r.error, 'error');
      else if (failed.length) notify(t("Verknüpfen fehlgeschlagen: {0}", [`${names(failed)} – ${r.failed[failed[0]]}`]), 'error');
      else if (r?.linked?.length) notify(t("Verknüpft: {0}", [names(r.linked)]));
      else notify(t("Kein Launcher-Konto angemeldet – melde dich zuerst bei Steam, Epic, GOG oder Riot an."), 'error');
    } finally { setRelinking(false); }
  };
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const r = await (mode === 'login' ? api.hub.login(name, pw) : api.hub.register(name, pw));
    setBusy(false);
    if (!r.ok) setError(r.error);
    else {
      setPw('');
      const names = (r.restored || []).map((k) => RESTORED_NAME[k]).filter(Boolean);
      notify(mode === 'login'
        ? (names.length ? t("Als {0} angemeldet – {1} gleich mit", [name, names.join(', ')]) : t("Als {0} angemeldet", [name]))
        : t("Ludora-Konto {0} angelegt", [name]));
    }
  }

  const linked = new Map((hub.links || []).map((l) => [l.launcher, l]));
  return (
    (<div className="assign-backdrop" onMouseDown={onClose}>
      <div className="assign hub" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t("Mein Ludora-Konto")}</h3>
        {!hub.configured ? (
          <p className="muted small">{t("Der Ludora-Server ist noch nicht eingerichtet. Trage die Adresse und den öffentlichen Schlüssel deines Supabase-Projekts in diese Datei ein (siehe Anleitung):")} <code>src-tauri/hub-config.json</code></p>
        ) : hub.status !== 'signedIn' ? (
          <>
            <p className="muted small">{t(
              "Mit einem Ludora-Konto erkennen Freunde, die auch Ludora nutzen, deine Steam-, Riot-, Epic- und GOG-Konten automatisch als dich."
            )}</p>
            <p className="muted small">{t(
              "Auf einem neuen PC oder Laptop meldest du dich nur hier an – deine Steam-, Epic- und GOG-Anmeldungen kommen Ende-zu-Ende-verschlüsselt mit (nur mit deinem Passwort lesbar)."
            )}</p>
            <div className="seg">
              <button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>{t("Anmelden")}</button>
              <button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>{t("Konto erstellen")}</button>
            </div>
            <form className="hub-form" onSubmit={submit}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Name, z. B. alex")} autoFocus autoComplete="username" />
              <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder={mode === 'register' ? t("Passwort (mind. {0} Zeichen)", [10]) : t("Passwort")} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              {mode === 'register' && <p className="muted small">{t(
                "Ohne E-Mail – merk dir dein Passwort gut, es lässt sich nicht zurücksetzen."
              )}</p>}
              <button className="primary" type="submit" disabled={busy || !name || !pw}>{busy ? '…' : mode === 'login' ? t("Anmelden") : t("Konto erstellen")}</button>
            </form>
            {(error || hub.error) && <p className="form-error">{error || hub.error}</p>}
          </>
        ) : (
          <>
            <p className="hub-me"><b>{hub.user?.display_name}</b> <span className="muted small">@{hub.user?.username}</span></p>
            <div className="hub-links">
              {['steam', 'riot', 'epic', 'gog'].map((l) => {
                const x = linked.get(l);
                return (
                  (<div key={l} className="hub-link">
                    <LauncherLogo provider={providerById[l]} small />
                    <span className="hub-link-name">{LAUNCHER_NAME[l]}</span>
                    {x ? (
                      <>
                        <span className="hub-link-acc">{x.account_name || x.account_id}</span>
                        <span className={`hub-link-state ${x.verified ? 'ok' : ''}`}>{x.verified ? t("✓ bestätigt") : t("nicht bestätigt")}</span>
                        <button className="link" onClick={() => api.hub.unlink(l, x.account_id)}>{t("Entfernen")}</button>
                      </>
                    ) : (() => {
                      // Nicht verknüpft: angemeldet -> „Verknüpfen“, sonst -> „Anmelden“
                      const st = launcherState(l);
                      const signedIn = st.status === 'connected';
                      const busy = linking === l || st.status === 'connecting';
                      return (
                        <>
                          <span className={hub.linkErrors?.[l] ? 'form-error small hub-link-acc' : 'muted small hub-link-acc'}>
                            {hub.linkErrors?.[l] ? t("Verknüpfen fehlgeschlagen: {0}", [hub.linkErrors[l]])
                              : signedIn ? t("angemeldet, noch nicht verknüpft")
                              : l === 'riot' ? t("Riot Client läuft nicht") : t("nicht angemeldet")}
                          </span>
                          {signedIn
                            ? <button className="secondary small" disabled={busy} onClick={() => linkOne(l)}>{busy ? t("Verknüpfe …") : t("Verknüpfen")}</button>
                            : <button className="primary small" disabled={busy} onClick={() => signIn(l)}>{busy ? t("Verbinde …") : l === 'riot' ? t("Riot starten") : t("Anmelden")}</button>}
                        </>
                      );
                    })()}
                  </div>)
                );
              })}
            </div>
            <p className="muted small">{t(
              "Melde dich bei einem Launcher an – danach wird er automatisch verknüpft. Steam, Epic und GOG werden dabei beim Anbieter bestätigt; Riot gibt nur lokale Daten heraus."
            )}</p>
            {hub.error && <p className="form-error">{hub.error}</p>}
            {hub.vaultError && <p className="form-error small">{hub.vaultError}</p>}
            <div className="hub-actions">
              <button className="secondary small" disabled={relinking} onClick={relink}>{relinking ? t("Verknüpfe …") : t("Alle neu verknüpfen")}</button>
              <button className="link" onClick={() => api.hub.logout()}>{t("Abmelden")}</button>
            </div>
            <button className="link danger small" onClick={async () => {
              const r = await api.hub.deleteAccount();
              if (r?.ok) { notify(t("Ludora-Konto gelöscht")); onClose(); } else if (r && !r.cancelled) notify(r.error || t("Löschen fehlgeschlagen"), 'error');
            }}>{t("Konto löschen …")}</button>
          </>
        )}
        <button className="link" onClick={onClose}>{t("Schließen")}</button>
      </div>
    </div>)
  );
}

/** Ludora: Freund hinzufügen + offene Anfragen */
function HubRequests({ incoming, outgoing, notify, error }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const r = await api.hub.friendRequest(name.trim());
    setBusy(false);
    if (r.ok) { notify(r.message); setName(''); } else notify(r.error, 'error');
  }
  return (
    (<div className="hub-requests">
      <form className="hub-add" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Ludora-Name, z. B. sam")} />
        <button className="primary small" type="submit" disabled={busy || !name.trim()}>{t("Freund hinzufügen")}</button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {incoming.length > 0 && (
        <div className="req-group">
          <h3>{t("Anfragen an dich")} <span className="count">{incoming.length}</span></h3>
          {incoming.map((f) => (
            <div key={f.username} className="req">
              <span className="avatar"><span>{f.displayName.slice(0, 1).toUpperCase()}</span></span>
              <span className="req-name">{f.displayName}<span className="muted small"> @{f.username}</span></span>
              <button className="play small" onClick={() => api.hub.friendAccept(f.username).then((r) => notify(r.ok ? t("Du bist jetzt mit {0} befreundet", [f.displayName]) : r.error, r.ok ? 'info' : 'error'))}>{t("Annehmen")}</button>
              <button className="secondary small" onClick={() => api.hub.friendRemove(f.username)}>{t("Ablehnen")}</button>
            </div>
          ))}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="req-group">
          <h3>{t("Gesendet")} <span className="count">{outgoing.length}</span></h3>
          {outgoing.map((f) => (
            <div key={f.username} className="req">
              <span className="avatar offline"><span>{f.displayName.slice(0, 1).toUpperCase()}</span></span>
              <span className="req-name">{f.displayName}<span className="muted small"> {t("wartet auf Annahme")}</span></span>
              <button className="link" onClick={() => api.hub.friendRemove(f.username)}>{t("Zurückziehen")}</button>
            </div>
          ))}
        </div>
      )}
    </div>)
  );
}

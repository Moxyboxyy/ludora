import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { LauncherLogo, UsersIcon } from './bits.jsx';
import { useExit } from '../useExit.js';

// Angedockte Freundesliste rechts im Hauptfenster: eingeklappt nur Avatare, aufgeklappt eine schlichte Liste.
// Alles Weitere (Personen, Ludora-Konto, Anmelden) bleibt im großen Freundefenster.

const LAUNCHER_NAME = { steam: 'Steam', riot: 'Riot', epic: 'Epic', gog: 'GOG' };
const LISTS = [['all', t("Alle Freunde")], ['steam', 'Steam'], ['riot', 'Riot'], ['epic', 'Epic'], ['gog', 'GOG']];
const loadTab = () => { try { return localStorage.getItem('friendsDockTab') || 'all'; } catch { return 'all'; } };
const saveTab = (v) => { try { localStorage.setItem('friendsDockTab', v); } catch { /* egal */ } };
const CHAT = new Set(['steam', 'riot', 'epic']);
const STATE = { online: t("Online"), away: t("Abwesend"), snooze: t("Abwesend"), busy: t("Beschäftigt") };
const rank = (a) => (a.gameName ? 4 : a.state === 'online' ? 3 : a.state === 'busy' ? 2.5 : 2);
const cls = (a) => (a.gameName ? 'ingame' : a.state);

function accountsOf(steam, others) {
  const list = [];
  if (steam?.status === 'connected') {
    for (const f of steam.friends || []) {
      list.push({ key: `steam:${f.steamid}`, chatId: f.steamid, launcher: 'steam', name: f.name, avatar: f.avatar, state: f.state,
        gameName: f.appid ? (f.gameName || t("Im Spiel")) : null, unread: f.unread || 0 });
    }
  }
  for (const [launcher, st] of Object.entries(others || {})) {
    if (st?.status !== 'connected') continue;
    for (const f of st.friends || []) {
      list.push({ key: `${launcher}:${f.id}`, chatId: `${launcher}:${f.id}`, launcher, name: f.name, avatar: f.avatar, state: f.state,
        gameName: f.state !== 'offline' ? f.gameName || null : null, unread: f.unread || 0 });
    }
  }
  return list;
}

function DockAvatar({ a }) {
  const [ok, setOk] = useState(true);
  return (
    <span className={`avatar ${cls(a)}`}>
      {a.avatar && ok ? <img src={a.avatar} alt="" onError={() => setOk(false)} /> : <span>{(a.name || '?').slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

export default function FriendsDock({ open, onToggle, onUndock, providerById = {}, notify }) {
  const [steam, setSteam] = useState(null);
  const [others, setOthers] = useState({});
  useEffect(() => {
    api.friends?.get?.().then(setSteam).catch(() => {});
    const offSteam = api.friends?.onUpdate?.(setSteam);
    api.friends2?.list?.().then((o) => setOthers(o || {})).catch(() => {});
    const offOthers = api.friends2?.onUpdate?.(({ id, state }) => setOthers((o) => ({ ...o, [id]: state })));
    return () => { offSteam?.(); offOthers?.(); };
  }, []);

  // Welche Liste: alle oder ein Launcher (Auswahl wie im Freundefenster: runde Knöpfe klappen nach unten auf)
  const [tab, setTab] = useState(loadTab);
  const [picker, setPicker] = useState(false);
  const [pickerShown, pickerClosing] = useExit(picker, 300);
  useEffect(() => {
    if (!picker) return undefined;
    const close = (e) => { if (!(e.target instanceof Element && e.target.closest('.fd-current, .fd-picker'))) setPicker(false); };
    const key = (e) => { if (e.key === 'Escape') setPicker(false); };
    const timer = setTimeout(() => { window.addEventListener('click', close); window.addEventListener('keydown', key); }, 0);
    return () => { clearTimeout(timer); window.removeEventListener('click', close); window.removeEventListener('keydown', key); };
  }, [picker]);
  const pick = (id) => { setTab(id); saveTab(id); setPicker(false); };
  const isConnected = (id) => (id === 'steam' ? steam?.status === 'connected' : others[id]?.status === 'connected');
  const logoOf = (id) => providerById[id] || { id, name: LAUNCHER_NAME[id] };

  const everyone = useMemo(() => accountsOf(steam, others), [steam, others]);
  const unreadBy = useMemo(() => {
    const m = { all: 0 };
    for (const a of everyone) if (a.unread > 0) { m[a.launcher] = (m[a.launcher] || 0) + a.unread; m.all += a.unread; }
    return m;
  }, [everyone]);
  const all = useMemo(() => (tab === 'all' ? everyone : everyone.filter((a) => a.launcher === tab)), [everyone, tab]);
  const currentName = LISTS.find((l) => l[0] === tab)?.[1] || LISTS[0][1];
  // Online zuerst (im Spiel > online > beschäftigt > abwesend), ungelesene ganz nach oben
  const online = useMemo(() => all.filter((a) => a.state !== 'offline')
    .sort((x, y) => (y.unread > 0) - (x.unread > 0) || rank(y) - rank(x) || x.name.localeCompare(y.name)), [all]);
  const unreadOffline = all.filter((a) => a.state === 'offline' && a.unread > 0);
  const list = [...unreadOffline, ...online];
  const connected = tab === 'all'
    ? (steam?.status === 'connected') || Object.values(others).some((s) => s?.status === 'connected')
    : isConnected(tab);

  const activate = async (a) => {
    if (CHAT.has(a.launcher)) {
      const r = await api.chat.open(a.chatId);
      if (r && !r.ok) notify?.(t("Nicht möglich"), 'error');
    } else {
      const r = await api.friends2.open(a.launcher);
      if (r?.ok) notify?.(t("{0} geöffnet – dort kannst du {1} schreiben.", [r.name, a.name]));
      else if (r?.error) notify?.(r.error, 'error');
    }
  };
  const status = (a) => (a.gameName || STATE[a.state] || t("Online"));

  return (
    <aside className={`friends-dock ${open ? 'open' : ''}`} aria-label={t("Freunde")}>
      <div className="fd-head">
        <button className="fd-btn" onClick={onToggle} aria-expanded={open}
          title={open ? t("Freundesliste einklappen") : t("Freundesliste aufklappen")} aria-label={open ? t("Freundesliste einklappen") : t("Freundesliste aufklappen")}>
          <svg viewBox="0 0 24 24" className={`fd-chev ${open ? 'open' : ''}`}><path d="m15 6-6 6 6 6" /></svg>
        </button>
        <button className="fd-current" onClick={() => setPicker((v) => !v)} aria-expanded={picker}
          title={t("Liste wählen – gerade: {0}", [currentName])} aria-label={t("Liste wählen – gerade: {0}", [currentName])}>
          {tab === 'all' ? <UsersIcon /> : <LauncherLogo provider={logoOf(tab)} dim={!isConnected(tab)} />}
          {!open && tab !== 'all' && unreadBy.all - (unreadBy[tab] || 0) > 0 && <span className="fd-dot" title={t("Ungelesene Nachrichten in anderen Listen")} />}
        </button>
        {open && <span className="fd-title">{currentName} <span className="fd-count">{online.length}</span></span>}
        {pickerShown && (
          <div className={`fd-picker ${pickerClosing ? 'closing' : ''}`} role="menu">
            {LISTS.map(([id, name], i) => (
              <button key={id} role="menuitem" className={`round-pick ${tab === id ? 'on' : ''}`} style={{ '--i': i }}
                onClick={() => pick(id)} title={name} aria-label={name}>
                {id === 'all' ? <UsersIcon /> : <LauncherLogo provider={logoOf(id)} dim={!isConnected(id)} />}
                {unreadBy[id] > 0 && <span className="fab-badge">{unreadBy[id]}</span>}
              </button>
            ))}
          </div>
        )}
        <button className="fd-btn" onClick={onUndock} title={t("Als eigenes Fenster öffnen")} aria-label={t("Als eigenes Fenster öffnen")}>
          <svg viewBox="0 0 24 24"><rect x="4" y="8" width="12" height="12" rx="2" /><path d="M10 4h10v10M20 4l-8 8" /></svg>
        </button>
      </div>
      <div className="fd-list">
        {list.map((a) => (
          <button key={a.key} className={`fd-friend ${cls(a)}`} onClick={() => activate(a)}
            title={`${a.name} – ${status(a)} (${LAUNCHER_NAME[a.launcher]})`}>
            <span className="fd-av">
              <DockAvatar a={a} />
              {a.unread > 0 && <span className="fab-badge">{a.unread}</span>}
            </span>
            {open && (
              <span className="fd-info">
                <span className="fd-name">{a.name}</span>
                <span className="fd-status">{status(a)}</span>
              </span>
            )}
            {open && tab === 'all' && <span className="acc-logo small"><LauncherLogo provider={providerById[a.launcher] || { id: a.launcher, name: LAUNCHER_NAME[a.launcher] }} small /></span>}
          </button>
        ))}
        {!list.length && open && (
          <div className="fd-empty">{connected ? t("Gerade ist niemand online.") : (tab === 'all' ? t("Kein Launcher angemeldet – öffne das Freundefenster, um dich anzumelden.") : t("Bei {0} nicht angemeldet – öffne das Freundefenster, um dich anzumelden.", [currentName]))}</div>
        )}
      </div>
    </aside>
  );
}

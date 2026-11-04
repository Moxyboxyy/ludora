import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { t, LOCALE } from '../i18n.js';

const STATE_LABEL = { online: t("Online"), away: t("Abwesend"), snooze: t("Abwesend"), busy: t("Beschäftigt"), offline: t("Offline") };

function time(ts) {
  const d = new Date(ts);
  const today = new Date();
  const hm = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return hm;
  return `${d.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' })} ${hm}`;
}

// Links im Text klickbar machen (öffnen im Standardbrowser)
function Text({ text }) {
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) => (/^https?:\/\//.test(p)
    ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a>
    : <React.Fragment key={i}>{p}</React.Fragment>));
}

const key = (m) => `${m.ts}|${m.fromMe}|${m.text}`;

export default function ChatWindow({ steamid }) {
  const [friend, setFriend] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);
  const typingTimer = useRef(null);
  const lastTypingSent = useRef(0);

  // Steam: SteamID64; Riot/Epic: "riot:<puuid>" / "epic:<accountId>"
  const [launcher, otherId] = /^(riot|epic):/.test(steamid) ? [steamid.split(':')[0], steamid.slice(steamid.indexOf(':') + 1)] : ['steam', steamid];
  const isSteam = launcher === 'steam';

  // Freund-Infos (Name, Status, Spiel) live mitführen
  useEffect(() => {
    if (isSteam) {
      const pick = (st) => setFriend(st.friends.find((f) => f.steamid === steamid) || null);
      api.friends.get().then(pick);
      return api.friends.onUpdate(pick);
    }
    const pick = (st) => {
      const f = (st?.friends || []).find((x) => x.id === otherId);
      setFriend(f ? { ...f, name: f.tag ? `${f.name}#${f.tag}` : f.name, appid: f.gameName ? f.gameName : null } : null);
    };
    api.friends2.list().then((all) => pick(all?.[launcher]));
    return api.friends2.onUpdate(({ id, state }) => { if (id === launcher) pick(state); });
  }, [steamid]);

  useEffect(() => {
    document.title = friend ? `${friend.name} – Chat` : 'Chat';
  }, [friend]);

  const merge = (incoming) => setMessages((prev) => {
    const map = new Map(prev.map((m) => [key(m), m]));
    for (const m of incoming) map.set(key(m), m);
    return [...map.values()].sort((a, b) => a.ts - b.ts);
  });

  // Verlauf laden + alle 10 s abgleichen (falls ein Live-Ereignis fehlt)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await api.chat.history(steamid);
      if (!alive) return;
      if (res.ok) { merge(res.messages); setError(''); } else setError(res.error);
    };
    load();
    api.chat.read(steamid);
    const timer = setInterval(load, isSteam ? 10000 : 15000);
    return () => { alive = false; clearInterval(timer); };
  }, [steamid]);

  // Live: neue Nachrichten und "schreibt gerade"
  useEffect(() => api.chat.onEvent((ev) => {
    if (ev.steamid !== steamid) return;
    if (ev.type === 'typing') {
      setTyping(true);
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setTyping(false), 6000);
      return;
    }
    if (ev.type === 'message') {
      if (!ev.fromMe) setTyping(false);
      merge([ev]);
      if (document.hasFocus()) api.chat.read(steamid);
    }
  }), [steamid]);

  useEffect(() => {
    const onFocus = () => api.chat.read(steamid);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [steamid]);

  // Immer ans Ende scrollen
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const res = await api.chat.send(steamid, text);
    setSending(false);
    if (res.ok) setDraft('');
    else setError(res.error || t("Senden fehlgeschlagen"));
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (Date.now() - lastTypingSent.current > 5000) {
      lastTypingSent.current = Date.now();
      api.chat.typing(steamid);
    }
  }

  // Nachrichten nach Tag gruppieren
  const grouped = useMemo(() => {
    const out = [];
    let day = '';
    for (const m of messages) {
      const d = new Date(m.ts).toLocaleDateString(LOCALE, { weekday: 'long', day: '2-digit', month: 'long' });
      if (d !== day) { out.push({ divider: d }); day = d; }
      out.push(m);
    }
    return out;
  }, [messages]);

  const status = friend
    ? friend.appid
      ? t(
    "Spielt {0}{1}",
    [friend.gameName || '', friend.richText ? ` · ${friend.richText}` : '']
  )
      : STATE_LABEL[friend.state] || ''
    : '';

  return (
    (<div className="chat">
      <header className="chat-head">
        <span className={`avatar ${friend?.appid ? 'ingame' : friend?.state || 'offline'}`}>
          {friend?.avatar ? <img src={friend.avatar} alt="" /> : <span>{(friend?.name || '?').slice(0, 1).toUpperCase()}</span>}
        </span>
        <div className="chat-who">
          <div className={`friend-name ${friend?.appid ? 'ingame' : friend?.state || ''}`}>{friend?.name || t("Lädt …")}</div>
          <div className="friend-status">{status}</div>
        </div>
        <div className="chat-head-actions">
          {!isSteam && (
            <button className="ghost" title={t("In {0} öffnen", [launcher === 'riot' ? 'Riot Client' : 'Epic Games'])} onClick={() => api.friends2.open(launcher)}>
              <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
            </button>
          )}
          {isSteam && friend?.joinable && (
            <button className="play small" onClick={() => api.friends.action(steamid, 'join')}>{t("Beitreten")}</button>
          )}
          {isSteam && (
            <button className="ghost" title={t("Profil anzeigen")} onClick={() => api.friends.action(steamid, 'profile')}>
              <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
            </button>
          )}
          {isSteam && (
            <button className="ghost" title={t("Im Steam-Chat öffnen")} onClick={() => api.friends.action(steamid, 'chat')}>
              <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
            </button>
          )}
        </div>
      </header>
      <div className="chat-list" ref={listRef}>
        {!messages.length && !error && <div className="drawer-empty">{t("Noch keine Nachrichten – schreib einfach los.")}</div>}
        {launcher === 'epic' && <div className="chat-day">{t("Epic liefert keinen alten Verlauf – Ludora speichert Nachrichten ab jetzt.")}</div>}
        {grouped.map((m, i) => (m.divider
          ? <div key={`d${i}`} className="chat-day">{m.divider}</div>
          : (
            <div key={key(m)} className={`bubble-row ${m.fromMe ? 'me' : ''}`}>
              <div className="bubble">
                <Text text={m.text} />
                <span className="bubble-time">{time(m.ts)}</span>
              </div>
            </div>
          )))}
        {typing && <div className="bubble-row"><div className="bubble typing"><span /><span /><span /></div></div>}
      </div>
      {error && <div className="chat-error">{error}</div>}
      <footer className="chat-input">
        <textarea
          rows={1}
          placeholder={friend ? t("Nachricht an {0}", [friend.name]) : t("Nachricht")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          autoFocus
        />
        <button className="primary" onClick={send} disabled={!draft.trim() || sending} title={t("Senden (Enter)")}>
          <svg viewBox="0 0 24 24" className="fill"><path d="M3 20.5 21 12 3 3.5l2.5 7.5L14 12l-8.5 1z" /></svg>
        </button>
      </footer>
    </div>)
  );
}

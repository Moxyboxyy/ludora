import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

/** Ungelesene Nachrichten je Launcher ({ total, steam, riot, … }) – für den Freunde-Knopf im Hauptfenster */
export function useFriendsUnread() {
  const [steam, setSteam] = useState(null);
  const [others, setOthers] = useState({});
  useEffect(() => {
    api.friends?.get?.().then(setSteam).catch(() => {});
    const offSteam = api.friends?.onUpdate?.(setSteam);
    api.friends2?.list?.().then((o) => setOthers(o || {})).catch(() => {});
    const offOthers = api.friends2?.onUpdate?.(({ id, state }) => setOthers((o) => ({ ...o, [id]: state })));
    return () => { offSteam?.(); offOthers?.(); };
  }, []);
  return useMemo(() => {
    const m = { total: 0 };
    const add = (launcher, n) => { if (n > 0) { m[launcher] = (m[launcher] || 0) + n; m.total += n; } };
    if (steam?.status === 'connected') for (const f of steam.friends || []) add('steam', f.unread || 0);
    for (const [launcher, st] of Object.entries(others)) {
      if (st?.status === 'connected') for (const f of st.friends || []) add(launcher, f.unread || 0);
    }
    return m;
  }, [steam, others]);
}

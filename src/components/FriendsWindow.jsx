import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { t } from '../i18n.js';
import FriendsPanel from './FriendsPanel.jsx';

/** Eigenes Freundefenster (#friends=<liste>): dieselbe Freundesliste wie früher im Hauptfenster */
export default function FriendsWindow({ tab }) {
  const [lib, setLib] = useState({ games: [], providers: [] });
  const [toast, setToast] = useState(null);

  useEffect(() => {
    document.title = t("Ludora – Freunde");
    api.cachedLibrary?.().then((r) => r && setLib({ games: r.games || [], providers: r.providers || [] })).catch(() => {});
  }, []);
  const providerById = useMemo(() => Object.fromEntries(lib.providers.map((p) => [p.id, p])), [lib.providers]);

  const notify = (text, kind = 'info') => {
    setToast({ text, kind, key: Date.now() });
    setTimeout(() => setToast((x) => (x && Date.now() - x.key >= 3900 ? null : x)), 4000);
  };
  const launch = async (game) => {
    const r = await api.launch(game.id);
    if (!r?.ok) notify(r?.error || t("Start fehlgeschlagen"), 'error');
    else notify(t("{0} wird über {1} gestartet …", [game.name, providerById[game.provider]?.name || '']));
  };

  return (
    <div className="friends-window-root">
      <FriendsPanel windowMode initialTab={tab} open games={lib.games} onLaunchGame={launch} notify={notify} providerById={providerById} onClose={() => window.close()} />
      {toast && <div key={toast.key} className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}

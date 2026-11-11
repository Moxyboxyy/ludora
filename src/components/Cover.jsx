import React, { useState } from 'react';

// Zeigt das erste Cover, das lädt. Gibt es keins, wird ein
// Platzhalter in der Farbe des Launchers mit den Initialen gezeichnet.
export default function Cover({ game, provider, wide = false }) {
  const urls = game.covers || [];
  const urlKey = urls.join('|');
  // Zustand hängt an der Cover-Liste: kommen neue Cover (Neu einlesen, nachgeladene Bilder), wird von vorne
  // probiert. Ohne Effekt, der zurücksetzt – der kam bei schnell geladenen Bildern erst nach onLoad und
  // ließ alle Cover unsichtbar.
  const [fail, setFail] = useState({ key: urlKey, idx: 0 });
  const idx = fail.key === urlKey ? fail.idx : 0;
  const imgKey = `${urlKey}#${idx}`;
  const [loadedKey, setLoadedKey] = useState(null);
  const loaded = loadedKey === imgKey;
  const [iconOk, setIconOk] = useState(true);

  const src = urls[idx];

  const initials = game.name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  const fallback = (
    <div
      className={`cover-fallback ${wide ? 'wide' : ''}`}
      style={{ '--c1': provider?.color || '#222', '--c2': provider?.accent || '#888' }}
    >
      {game.iconUrl && iconOk ? (
        <img className={`fallback-icon ${/^(ghimg:\/\/|http:\/\/ghimg\.localhost\/)riot\//.test(game.iconUrl) ? 'big' : ''}`} src={game.iconUrl} alt="" draggable={false} onError={() => setIconOk(false)} />
      ) : (
        <span className="initials">{initials || '?'}</span>
      )}
      {!wide && <span className="fallback-name">{game.name}</span>}
    </div>
  );

  return (<>
    {!loaded && fallback}
    {src && (
      <img
        key={imgKey}
        className={`cover-img ${loaded ? 'in' : 'loading'} ${wide ? 'wide' : ''}`}
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onLoad={() => setLoadedKey(imgKey)}
        onError={() => setFail({ key: urlKey, idx: idx + 1 })}
      />
    )}
  </>);
}

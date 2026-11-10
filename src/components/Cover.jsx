import React, { useEffect, useState } from 'react';

// Zeigt das erste Cover, das lädt. Gibt es keins, wird ein
// Platzhalter in der Farbe des Launchers mit den Initialen gezeichnet.
export default function Cover({ game, provider, wide = false }) {
  const urls = game.covers || [];
  const urlKey = urls.join('|');
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [iconOk, setIconOk] = useState(true);

  // Neue Cover nachgeliefert -> von vorne probieren
  useEffect(() => { setIdx(0); setLoaded(false); }, [urlKey]);

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
        key={src}
        className={`cover-img ${loaded ? 'in' : 'loading'} ${wide ? 'wide' : ''}`}
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => { setLoaded(false); setIdx((i) => i + 1); }}
      />
    )}
  </>);
}

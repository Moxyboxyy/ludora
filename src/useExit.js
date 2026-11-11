import { useEffect, useState } from 'react';

/** Für Einklapp-Animationen: bleibt nach dem Schließen noch `ms` lang sichtbar (mit closing = true) */
export function useExit(open, ms = 220) {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) { setShown(true); return undefined; }
    const timer = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(timer);
  }, [open, ms]);
  return [open || shown, !open && shown];
}

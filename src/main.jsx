import './styles.css';
import { isTauri, installTauriBridge } from './tauriBridge.js';
import { installReloadGuards, hideReloadSplash } from './reload.js';

installReloadGuards();

// Eigene Chatfenster laden dieselbe Seite mit #chat=<steamid>
const chatRaw = window.location.hash.match(/^#chat=(.+)$/);
const chat = chatRaw && /^(\d{17}|(riot|epic):[A-Za-z0-9-]{8,80})$/.test(decodeURIComponent(chatRaw[1])) ? [null, decodeURIComponent(chatRaw[1])] : null;
// Eigenes Freundefenster: #friends=<liste>
const friendsRaw = window.location.hash.match(/^#friends=(all|hub|steam|riot|epic|gog)(&hub)?$/);
const friendsTab = friendsRaw ? friendsRaw[1] : null;
const friendsHub = !!friendsRaw?.[2]; // gleich das Ludora-Konto öffnen (Klick auf den Namen oben im Hauptfenster)

async function start() {
  // Rust-Version: window.gamehub erst aufbauen – api.js und i18n.js lesen es beim Laden
  if (isTauri()) await installTauriBridge();
  // Funktionstest-Fenster (nur Testversion: im Release-Build fällt dieser Zweig komplett weg)
  if (import.meta.env.DEV && window.location.hash === '#debug') {
    const [{ default: React }, { createRoot }, { default: DebugWindow }] = await Promise.all([
      import('react'), import('react-dom/client'), import('./debug/DebugWindow.jsx')
    ]);
    createRoot(document.getElementById('root')).render(React.createElement(DebugWindow));
    return;
  }
  const [{ default: React }, { createRoot }] = await Promise.all([import('react'), import('react-dom/client')]);
  let view;
  if (chat) view = React.createElement((await import('./components/ChatWindow.jsx')).default, { steamid: chat[1] });
  else if (friendsTab) view = React.createElement((await import('./components/FriendsWindow.jsx')).default, { tab: friendsTab, openHub: friendsHub });
  else view = React.createElement((await import('./App.jsx')).default);
  createRoot(document.getElementById('root')).render(view);
  signalReady();
  hideReloadSplash();
}

// Rust zeigt das Hauptfenster erst, wenn die Oberfläche steht und die Logo-Animation (eigenes Fenster) durch ist
function signalReady() {
  if (!isTauri()) return;
  import('@tauri-apps/api/core').then(({ invoke }) => invoke('ipc', { channel: 'app:ready', args: [] })).catch(() => {});
}

// Startfehler sichtbar machen statt eines leeren Fensters
function showError(err) {
  const root = document.getElementById('root');
  if (!root || root.childElementCount) return; // Oberfläche steht schon
  root.innerHTML = '';
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#ff6b6b;padding:24px;white-space:pre-wrap;font:13px monospace';
  pre.textContent = 'Ludora konnte nicht starten:\n\n' + (err && (err.stack || err.message) || String(err));
  root.appendChild(pre);
  signalReady();
  document.getElementById('reload-splash')?.remove();
}
window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

start().catch(showError);

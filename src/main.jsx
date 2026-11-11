import './styles.css';
import { isTauri, installTauriBridge } from './tauriBridge.js';

// Eigene Chatfenster laden dieselbe Seite mit #chat=<steamid>
const chatRaw = window.location.hash.match(/^#chat=(.+)$/);
const chat = chatRaw && /^(\d{17}|(riot|epic):[A-Za-z0-9-]{8,80})$/.test(decodeURIComponent(chatRaw[1])) ? [null, decodeURIComponent(chatRaw[1])] : null;

async function start() {
  // Rust-Version: window.gamehub erst aufbauen – api.js und i18n.js lesen es beim Laden
  if (isTauri()) await installTauriBridge();
  const [{ default: React }, { createRoot }, { default: App }, { default: ChatWindow }] = await Promise.all([
    import('react'), import('react-dom/client'), import('./App.jsx'), import('./components/ChatWindow.jsx')
  ]);
  createRoot(document.getElementById('root')).render(
    chat ? React.createElement(ChatWindow, { steamid: chat[1] }) : React.createElement(App)
  );
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
}
window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

start().catch(showError);

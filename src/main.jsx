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

start();

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import './styles.css';

// Eigene Chatfenster laden dieselbe Seite mit #chat=<steamid>
const chatRaw = window.location.hash.match(/^#chat=(.+)$/);
const chat = chatRaw && /^(\d{17}|(riot|epic):[A-Za-z0-9-]{8,80})$/.test(decodeURIComponent(chatRaw[1])) ? [null, decodeURIComponent(chatRaw[1])] : null;

createRoot(document.getElementById('root')).render(
  chat ? <ChatWindow steamid={chat[1]} /> : <App />
);

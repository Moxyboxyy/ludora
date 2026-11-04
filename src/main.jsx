import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import './styles.css';

// Eigene Chatfenster laden dieselbe Seite mit #chat=<steamid>
const chat = window.location.hash.match(/^#chat=(\d{17})$/);

createRoot(document.getElementById('root')).render(
  chat ? <ChatWindow steamid={chat[1]} /> : <App />
);

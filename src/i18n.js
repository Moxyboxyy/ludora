// Übersetzungen: Die Texte im Code sind Deutsch und dienen als Schlüssel.
// src-tauri/i18n/en.json übersetzt sie ins Englische (Standardsprache). Platzhalter: {0}, {1}, …
import en from '../src-tauri/i18n/en.json';

const DICTS = { en };
export const LANGUAGES = [['en', 'English'], ['de', 'Deutsch']];
export const language = (typeof window !== 'undefined' && window.gamehub?.language) || 'en';

export const LOCALE = language === 'de' ? 'de-DE' : 'en-US';
export const DEC = language === 'de' ? ',' : '.'; // Dezimaltrennzeichen

export function t(text, args) {
  let s = (DICTS[language] && DICTS[language][text]) || text;
  if (args) s = s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined || args[i] === null ? '' : String(args[i])));
  return s;
}

// Übersetzungen im Hauptprozess (Tray, Dialoge, Meldungen). Gleiches Wörterbuch wie die Oberfläche.
// Bis setLanguage() aufgerufen wird (beim Start), bleibt alles Deutsch – so laufen auch die Tests.
const en = require('../i18n/en.json');

const DICTS = { en };
let lang = 'de';

function setLanguage(l) { lang = DICTS[l] || l === 'de' ? l : 'en'; }
function getLanguage() { return lang; }

function t(text, args) {
  let s = (DICTS[lang] && DICTS[lang][text]) || text;
  if (args) s = s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined || args[i] === null ? '' : String(args[i])));
  return s;
}

module.exports = { t, setLanguage, getLanguage };

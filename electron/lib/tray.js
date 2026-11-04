// Tray-Symbol (Windows: unten rechts neben der Uhr, macOS: oben in der Menüleiste, Linux: Infobereich)
// wie bei Steam & Co.: Klick holt Ludora nach vorne, Rechtsklick zeigt das Menü mit den Bereichen,
// Favoriten zum direkten Starten und "Beenden".
const { t } = require('./i18n.js');
const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

let tray = null;
let opts = null;

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  // Windows/Linux: 16 px (Windows skaliert bei hoher Auflösung selbst), macOS: 18 pt Menüleiste
  const size = process.platform === 'darwin' ? 18 : process.platform === 'win32' ? 16 : 24;
  return img.isEmpty() ? img : img.resize({ width: size, height: size, quality: 'best' });
}

function buildMenu() {
  const { show, navigate, favorites, launch, quit, downloadsLabel } = opts;
  const favs = favorites().slice(0, 10);
  const dl = downloadsLabel?.();
  return Menu.buildFromTemplate([
    { label: t("Ludora öffnen"), click: show },
    { type: 'separator' },
    { label: t("Bibliothek"), click: () => navigate('library') },
    { label: t("Shop"), click: () => navigate('shop') },
    { label: dl ? t("Downloads ({0})", [dl]) : t("Downloads"), click: () => navigate('downloads') },
    { label: t("Freunde"), click: () => navigate('friends') },
    { type: 'separator' },
    favs.length
      ? { label: t("Favoriten"), submenu: favs.map((g) => ({ label: g.name, click: () => launch(g.id) })) }
      : { label: t("Favoriten (noch keine)"), enabled: false },
    { type: 'separator' },
    { label: t("Einstellungen"), click: () => navigate('settings') },
    { label: t("Ludora beenden"), click: quit }
  ]);
}

/** Tray anlegen. Das Menü wird bei jedem Öffnen neu gebaut, damit Favoriten/Downloads aktuell sind. */
function create(options) {
  if (tray) return tray;
  opts = options;
  tray = new Tray(trayImage());
  tray.setToolTip('Ludora');
  if (process.platform === 'darwin') {
    // macOS: Klick öffnet das Menü (wie bei anderen Menüleisten-Symbolen)
    tray.on('mouse-down', () => tray.setContextMenu(buildMenu()));
    tray.setContextMenu(buildMenu());
  } else {
    tray.on('click', () => options.toggle());
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    // Linux (AppIndicator) kennt oft nur das Kontextmenü
    if (process.platform === 'linux') tray.setContextMenu(buildMenu());
  }
  return tray;
}

function setTooltip(text) {
  if (tray && !tray.isDestroyed()) tray.setToolTip(text || 'Ludora');
}

function refreshMenu() {
  if (tray && !tray.isDestroyed() && process.platform !== 'win32') tray.setContextMenu(buildMenu());
}

function destroy() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { create, setTooltip, refreshMenu, destroy };

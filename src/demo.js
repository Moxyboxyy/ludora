// Beispieldaten für die Browser-Vorschau (ohne Electron)
import { t } from './i18n.js';
const P = {
  steam: { name: 'Steam', color: '#1b2838', accent: '#66c0f4' },
  epic: { name: 'Epic Games', color: '#2a2a2a', accent: '#f5f5f5' },
  gog: { name: 'GOG', color: '#3b1f4f', accent: '#c79bff' },
  ea: { name: 'EA app', color: '#3a0d12', accent: '#ff4747' },
  ubisoft: { name: 'Ubisoft Connect', color: '#0e1a3a', accent: '#5aa0ff' },
  battlenet: { name: 'Battle.net', color: '#0b1a2e', accent: '#148eff' },
  amazon: { name: 'Amazon Games', color: '#1a2330', accent: '#ff9900' },
  riot: { name: 'Riot Games', color: '#2b0d0f', accent: '#ff4655' },
  rockstar: { name: 'Rockstar', color: '#2a2306', accent: '#fcaf17' },
  manual: { name: t('Eigene Spiele'), color: '#1f2a24', accent: '#7ee2a8' }
};

const steam = (id, name) => ({
  provider: 'steam', nativeId: String(id), name, status: 'installed',
  covers: [
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`
  ]
});
const other = (provider, name, status = 'installed') => ({
  provider, nativeId: name.toLowerCase().replace(/\W+/g, '-'), name, status, covers: []
});

export function demoScan() {
  const games = [
    steam(3354750, 'skate.'),
    steam(1145360, 'Hades'),
    steam(413150, 'Stardew Valley'),
    steam(1086940, "Baldur's Gate 3"),
    steam(730, 'Counter-Strike 2'),
    { ...steam(1245620, 'Elden Ring'), status: 'updating' },
    other('epic', 'Fortnite'),
    other('epic', 'Rocket League'),
    other('gog', 'The Witcher 3: Wild Hunt'),
    other('gog', 'Cyberpunk 2077'),
    other('ea', 'EA SPORTS FC 26'),
    other('ubisoft', "Assassin's Creed Shadows"),
    other('battlenet', 'Diablo IV'),
    other('battlenet', 'Overwatch 2'),
    other('riot', 'VALORANT'),
    other('rockstar', 'Grand Theft Auto V'),
    other('amazon', 'Fallout 76'),
    { ...other('manual', 'Minecraft'), removable: true },
    { ...steam(292030, 'The Witcher 3: Wild Hunt'), status: 'notInstalled', playtimeMin: 4210 },
    { ...steam(1174180, 'Red Dead Redemption 2'), status: 'notInstalled', playtimeMin: 830 },
    { ...steam(367520, 'Hollow Knight'), status: 'notInstalled', playtimeMin: 0 },
    { ...steam(814380, 'Sekiro: Shadows Die Twice'), status: 'notInstalled', playtimeMin: 95 }
  ].map((g) => ({ ...g, id: `${g.provider}:${g.nativeId}`, installDir: 'C:\\Games\\' + g.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));

  const providers = Object.entries(P).map(([id, p]) => ({
    id, ...p, enabled: id !== 'amazon', hasClient: id !== 'manual', hasStore: id !== 'manual', count: games.filter((g) => g.provider === id).length, error: null
  }));
  return { games, providers, scannedAt: new Date().toISOString() };
}

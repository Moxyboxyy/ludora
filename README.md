# Ludora - the Client for all Game Clients

**English** · [Deutsch](README.de.md)

Ludora brings all your PC games from **Steam, Epic Games, GOG, EA app, Ubisoft Connect, Battle.net, Amazon Games,
Riot Games and Rockstar** together in **one** app. You see your whole library in one place, start, update and
uninstall games with one click, follow every download live, see your friends from all platforms in one list and
search every store for games and deals – while the individual launchers stay quietly in the background.

> **Note:** Ludora is a private open-source project and is **not** affiliated with, endorsed or reviewed by Valve,
> Epic Games, GOG, Electronic Arts, Ubisoft, Blizzard Entertainment, Riot Games, Rockstar Games or Amazon.
> All names, logos and trademarks belong to their respective owners. Purchases always happen directly in the
> respective store. See [Legal & risks](#legal--risks).

## Contents

- [What Ludora does](#what-ludora-does)
- [Installation](#installation)
- [Getting started – client tutorial](#getting-started--client-tutorial)
- [Supported launchers](#supported-launchers)
- [Privacy](#privacy)
- [Legal & risks](#legal--risks)
- [For developers](#for-developers)
- [License](#license)

## What Ludora does

| Feature | What it means |
|---|---|
| **One library** | All installed games of all launchers – plus owned but not installed games where the launcher provides them – with covers, playtime and “last played”. Grid or list view, filters and sorting. |
| **Play, update, uninstall** | One click starts the game through its own launcher, which starts hidden in the background. Updates and uninstalls also run through the launchers, silently where the launcher allows it. |
| **Downloads** | Progress, speed and remaining time of every running download and update – live, from all launchers in one list. |
| **Favorites** | Mark any game with a star – no matter which launcher – and find it under “Favorites”. |
| **Friends** | Steam, Riot, Epic and GOG friends in one list, including what they are playing. Chat with Steam friends directly in Ludora. |
| **Ludora account (optional)** | Friends who also use Ludora see all your launcher accounts as **one person** and can add you by your Ludora name. |
| **Store & deals** | Search all stores at once. Each game shows in which stores you can buy it; one click opens the game page in that store (or its launcher). “Deals” shows only discounted games. |
| **Tray** | Ludora keeps running in the background when you close the window (icon next to the clock / in the menu bar), like other launchers. Optionally starts with your system. |
| **Languages** | English (default) and German, switchable in the settings. |

Ludora never sees your launcher passwords: signing in always happens on the provider's real page, and sign-in
tokens are stored encrypted on your PC only.

## Installation

Download the file for your system from the [**latest release**](https://github.com/MaxiMagDich93/ludora/releases/latest).

### Windows 10 / 11

1. Download **`Ludora-Setup-<version>.exe`**.
2. Double-click it. The installer isn't code-signed, so Windows SmartScreen may show “Windows protected your PC” –
   click **More info → Run anyway**.
3. Choose the install folder and click **Install**. Ludora gets a Start menu and desktop shortcut and starts afterwards.
4. To uninstall, use **Settings → Apps** in Windows. Your games are not touched.

### macOS (12 Monterey or newer)

1. Download **`Ludora-<version>-mac-AppleSilicon.zip`** for Macs with an M1/M2/M3/M4 chip, or
   **`Ludora-<version>-mac-Intel.zip`** for Intel Macs ( → *About This Mac* shows which one you have).
2. Double-click the zip and drag **Ludora.app** into **Applications**.
3. The app isn't notarized by Apple. On the first start **right-click Ludora → Open → Open**
   (or *System Settings → Privacy & Security → Open Anyway*).
4. macOS asks once whether Ludora may control “System Events” – allow it so Ludora can hide launcher windows.

### Linux (x64)

- **AppImage (any distribution):** download **`Ludora-<version>-x86_64.AppImage`**, run
  `chmod +x Ludora-*.AppImage` and start it with a double-click or `./Ludora-*.AppImage`.
- **Debian / Ubuntu:** download **`Ludora-<version>-amd64.deb`** and run `sudo apt install ./Ludora-*-amd64.deb`.
  Ludora then appears in your app menu.

On Linux most launchers don't exist natively, so Ludora reads the two tools Linux gamers use instead: **[Heroic](https://heroicgameslauncher.com)** (Epic Games, GOG, Amazon) and **[Lutris](https://lutris.net)** (Battle.net, EA app, Ubisoft Connect, Rockstar and everything else). Install the games there once – Ludora shows them in one library and starts them. Normal and Flatpak installs are supported. Riot games (Valorant, League of Legends) don't run on Linux because of Riot's anti-cheat.

## Getting started – client tutorial

### 1. First start
Ludora scans your PC for installed launchers and games – no sign-in needed. Launchers with games appear on the left
under **Launcher**, launchers that aren't installed under **Not installed**. Ludora remembers your library, so later
starts are instant while it rescans in the background.

### 2. The window
- **Top bar:** the **Ludora** menu (account, rescan library, settings, about, quit), the areas **Library** and
  **Store**, and your **Ludora account** on the right.
- **Sidebar:** *All games*, *Favorites* and one entry per launcher. The small button next to a launcher opens that
  launcher. At the bottom: **Downloads** and **Add game**. The button next to “Library” collapses the sidebar to icons.
- **Bottom right:** the round **friends** button with the number of friends online.

### 3. Library
- Switch between **Installed / All / Not installed**, sort by name, playtime or last played, search at the top and
  toggle **grid / list**.
- Hover a game: **Play** (or **Install** / **Update**), star = favorite, folder = open install folder,
  picture = change cover, trash can = uninstall.
- A green **Running** badge marks games that are running – clicking brings the game to the front.

### 4. Updates & downloads
- Games with an update show **Update**. Ludora starts the launcher invisibly and lets it download.
- **Downloads** (bottom left) lists everything that is downloading, paused or waiting, with %, speed and remaining
  time. Where a launcher only allows pausing in its own window, the pause/resume button opens that view.

### 5. Add your own games
**Add game** accepts any `.exe`, `.lnk`, `.url` or `.bat` file (Windows) or `.app` (Mac), optionally with launch
options – for games without a launcher or for emulators.

### 6. Store & deals
- Open **Store** at the top. Without a search you see top sellers and new releases from all stores; type to search
  all stores at once.
- The icons on each game show where you can buy it – a click opens the game page in that store (in the launcher if
  it's installed). Games you already own are marked **In your library** with the logo of the launcher you own them on.
- Use the store buttons to show a single store, **Deals** for discounted games, the sort menu next to “Store” and the
  grid/list switch.

### 7. Friends
- Click the round button at the bottom right. Tabs: **All**, **Ludora**, **Steam**, **Riot**, **Epic**, **GOG**.
- **Steam:** sign in once by scanning the QR code with the Steam mobile app. **Epic / GOG:** sign in once on their
  real page. **Riot:** needs the Riot Client running – Ludora can start it hidden.
- Right-click a friend for actions: chat, join game, view profile, or group several accounts into one person.

### 8. Ludora account (optional)
Click **Sign in** (or your name) at the top right and create an account with **name and password** – no email needed.
Ludora then links your signed-in launcher accounts automatically, so friends who use Ludora recognize you on every
platform. Add friends by their Ludora name and accept requests in the **Ludora** tab. **Delete account …** removes
everything from the server.

### 9. Tray & settings
- Closing the window keeps Ludora running in the tray (icon next to the clock / in the menu bar). Click it to open
  Ludora; right-click for library, store, downloads, friends, your favorites and **Quit Ludora**.
- **Settings** (Ludora menu): language, keep running when closed, start with the system, how launchers behave when
  a game starts (hidden / minimized / normal), which launchers to read, optional Steam API key and SteamGridDB key,
  image cache.

## Supported launchers

| Launcher | Windows | macOS | Linux |
|---|---|---|---|
| Steam | ✅ | ✅ | ✅ |
| Epic Games | ✅ | ✅ | ✅ via Heroic |
| GOG Galaxy | ✅ | ✅ | ✅ via Heroic |
| Battle.net | ✅ | ✅ | ✅ via Lutris |
| Riot Games | ✅ | ✅ | – |
| EA app, Ubisoft Connect, Rockstar | ✅ | – | ✅ via Lutris |
| Amazon Games | ✅ | – | ✅ via Heroic |
| Other Lutris games (emulators, GZDoom, …) | – | – | ✅ |
| Own games | ✅ | ✅ | ✅ |

Ludora reads the data the launchers keep on your PC anyway (install lists, manifests, download logs) and always starts
games through the launcher itself (e.g. `steam://rungameid/<id>`).

## Privacy

Short version: almost everything stays on your PC. Sign-in tokens are encrypted with your operating system's key
store. An (optional) Ludora account stores only your Ludora name, a password hash, the IDs of the launcher accounts you
link and your Ludora friendships. Details: [PRIVACY.md](PRIVACY.md).

## Legal & risks

Besides official interfaces (e.g. the Steam Web API) Ludora also uses **unofficial, undocumented** interfaces of the
launchers – like other open-source launchers such as Heroic, Legendary or Playnite. Providers may change or block them
at any time. Use at your own risk.

- **Steam:** friends/chat via Steam's web chat interface ([steam-user](https://github.com/DoctorMcKay/node-steam-user)), store search via the store website.
- **Epic Games / GOG:** sign-in, friends and store via the interfaces of the official launchers.
- **Riot Games:** only the local interface of the running Riot Client (friends, updates).
  *Ludora isn’t endorsed by Riot Games and doesn’t reflect the views or opinions of Riot Games or anyone officially
  involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks
  or registered trademarks of Riot Games, Inc.*
- **Battle.net:** Ludora reads local files and changes one setting in `Battle.net.config` to start updates. The
  complete library via account sign-in is **off by default** (Settings → Advanced) because it uses an unofficial
  interface that, according to Blizzard, may violate their terms of use.
- **Store:** prices from Steam, Epic Games and GOG; EA, Ubisoft and Battle.net via [CheapShark](https://www.cheapshark.com).
  Store images and icons are loaded from the stores at runtime and are not part of this repository.

Ludora does not modify game clients and gives no advantage in games.

## For developers

Requirements: [Node.js](https://nodejs.org) (LTS).

```bash
git clone https://github.com/MaxiMagDich93/ludora.git
cd ludora
npm install
npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app with live reload |
| `npm start` | Builds the UI and starts the app without the dev server |
| `npm test` | Runs the tests |
| `npm run dist` | Windows installer in `release/` |
| `npm run dist:mac` | Mac app (on a Mac) |

```
electron/
  main.js            window, tray, launching games, IPC
  preload.js         safe bridge to the UI
  i18n/              translations (German source texts → en.json)
  lib/               helpers (registry, VDF, store, friends, accounts, …)
  providers/         one module per launcher
src/                 React UI
supabase/            database schema and verification function for Ludora accounts
tests/               tests
```

- **New launcher:** create `electron/providers/<name>.js` with `{ id, name, color, accent, detect() }` and add it to
  `electron/providers/index.js`.
- **New language:** create `electron/i18n/<code>.json` like `en.json` and register it in `src/i18n.js` and
  `electron/lib/i18n.js`.

### Your own Ludora server (for Ludora accounts)

Ludora accounts need a small [Supabase](https://supabase.com) project (the free tier is enough). Everyone who builds
Ludora themselves needs their own project:

1. Create a project on supabase.com.
2. **SQL Editor:** run `supabase/schema.sql`, then `supabase/02_friends.sql` and `supabase/03_delete_account.sql`.
3. **Authentication → Sign In / Providers → Email:** turn off “Confirm email” (Ludora accounts have no email).
4. **Edge Functions:** create a function with the content of `supabase/functions/link/index.ts` and turn off “Verify JWT”.
5. Copy `electron/hub-config.example.json` to `electron/hub-config.json` and enter the *Project URL*, the **public**
   key (*anon* / *publishable*) and the function name. Never put the *secret* / *service_role* key into the app.
   `hub-config.json` is git-ignored.

Without `hub-config.json` everything except Ludora accounts works. `supabase/test_dummies.sql` creates two test profiles.

## License

[MIT](LICENSE) © 2026 Moxyboxyy

**Ludora - the Client for all Game Clients** · Release 0.8.0

### What's new: Ludora is now a Rust app
Ludora has been rebuilt from Electron to **Rust (Tauri)**. Everything you know works the same – library, launching, updates, downloads, friends, chat, Ludora accounts and the shop – but the app is much lighter:
- **Far less RAM and CPU:** no bundled Chromium anymore; Ludora uses the web view built into your system. Download size drops from ~130 MB to a fraction of that.
- **Even lighter in the tray:** while the window is hidden, Ludora checks friends and accounts less often, and on Windows the web view switches to low-memory mode.
- **Large libraries scroll smoothly:** cards outside the screen aren't drawn, and expensive blur effects are gone.
- **Steam chat is live:** new messages (also ones you write on your phone) and "is typing …" arrive instantly; friends' status updates right away. Clicking a chat notification opens the chat (Windows).
- **Shop:** Epic works again, and the EA tab now shows EA games (via the Steam store).
- **Covers:** no more invisible covers after "Rescan library"; portrait covers missing on Steam's CDN are fetched from the Steam store.

### Updating from 0.7.x
Just click the update button as usual. On Windows the new version replaces the old one in the same folder (Windows asks once for admin rights), your settings, sign-ins and covers stay. If you had autostart on, it stays on.

### Downloads
| System | File |
|---|---|
| Windows 10/11 | `Ludora-Setup-0.8.0.exe` |
| macOS (Apple Silicon) | `Ludora-0.8.0-arm64.dmg` (or `.zip`) |
| macOS (Intel) | `Ludora-0.8.0-x64.dmg` (or `.zip`) |
| Linux (any distribution) | `Ludora-0.8.0-x86_64.AppImage` |
| Debian / Ubuntu | `Ludora-0.8.0-amd64.deb` |

The files are not code-signed: on Windows click **More info → Run anyway**, on macOS **right-click → Open** on the first start.
[Installation](https://github.com/Moxyboxyy/ludora#installation) · [Anleitung auf Deutsch](https://github.com/Moxyboxyy/ludora/blob/main/README.de.md#installation)

---

**Deutsch:** Ludora ist jetzt eine Rust-App (Tauri) statt Electron. Alles funktioniert wie gewohnt, braucht aber deutlich weniger Arbeitsspeicher und CPU; der Download ist viel kleiner. Im Tray fragt Ludora seltener nach, große Bibliotheken scrollen flüssiger. Steam-Chat kommt jetzt live an (auch „schreibt gerade …“), ein Klick auf die Benachrichtigung öffnet den Chat. Im Shop gehen Epic und EA wieder, und Cover verschwinden nach „Bibliothek neu einlesen“ nicht mehr. Update wie gewohnt über den Update-Knopf: Unter Windows ersetzt die neue Version die alte im selben Ordner (einmal Admin-Rechte bestätigen); Einstellungen, Anmeldungen und Autostart bleiben.

Ludora is not affiliated with Valve, Epic Games, GOG, EA, Ubisoft, Blizzard, Riot Games, Rockstar Games or Amazon.

**Ludora - the Client for all Game Clients** · Release 0.7.10

### What's new
- **Ludora restarts reliably after its own updates:** the new version used to start while the old one was still closing – it then saw "Ludora is already running" and quit again. Now a small helper waits until the old Ludora has really exited, installs the update and only then starts Ludora again (on Windows, macOS and Linux). Takes effect from the next update after this one.
- **Steam game updates, next round:** requests to Steam now time out after 20–30 seconds instead of hanging forever (you get a message with the reason), Steam's 64-bit device IDs are read without rounding, and Ludora recognises this PC even when Steam doesn't report its name.
- Every step of a Steam update is now written to the log file (`%APPDATA%\Ludora\logs\main.log`), so remaining problems can be tracked down quickly.
- Offline devices (e.g. a sleeping laptop) no longer flood the log from the Stream tab.

### Downloads
| System | File |
|---|---|
| Windows 10/11 | `Ludora-Setup-0.7.10.exe` |
| macOS (Apple Silicon M1–M4) | `Ludora-0.7.10-arm64.dmg` (or `.zip`) |
| macOS (Intel) | `Ludora-0.7.10-x64.dmg` (or `.zip`) |
| Linux (any distribution) | `Ludora-0.7.10-x86_64.AppImage` |
| Debian / Ubuntu | `Ludora-0.7.10-amd64.deb` |

The files are not code-signed: on Windows click **More info → Run anyway**, on macOS **right-click → Open** on the first start.
[Installation](https://github.com/Moxyboxyy/ludora#installation) · [Anleitung auf Deutsch](https://github.com/Moxyboxyy/ludora/blob/main/README.de.md#installation)

---

**Deutsch:** Ludora startet nach eigenen Updates jetzt zuverlässig neu: Ein Hilfsskript wartet, bis das alte Ludora wirklich beendet ist, installiert dann und startet Ludora erst danach (wirkt ab dem nächsten Update). Steam-Spiel-Updates, nächste Runde: Anfragen an Steam brechen nach 20–30 Sekunden mit einer Meldung ab, statt endlos zu hängen; Steams Geräte-IDs werden nicht mehr gerundet, und Ludora erkennt diesen PC auch ohne Gerätenamen. Jeder Schritt landet in der Protokolldatei (`%APPDATA%\Ludora\logs\main.log`).

Ludora is not affiliated with Valve, Epic Games, GOG, EA, Ubisoft, Blizzard, Riot Games, Rockstar Games or Amazon.

**Ludora - the Client for all Game Clients** · Release 0.7.0

### What's new
- **Ludora remembers your sign-ins:** Steam, Epic, GOG and your Ludora account stay signed in across restarts; after a network hiccup Ludora simply retries instead of asking you to sign in again.
- **Sign in once, everywhere:** with a Ludora account, your Steam, Epic and GOG sign-ins come along to your other PCs and laptops – end-to-end encrypted, readable only with your password.

### Security
- **Your Ludora password never leaves your device.** Ludora only sends a value derived from it; the key for your synced sign-ins is derived separately, so the server can't open them. Existing accounts are switched over automatically at the next sign-in. New passwords need at least 10 characters.
- **Signed updates:** Ludora only installs updates signed with the developer's offline key and checks every download's SHA-256 checksum. Even someone who took over the GitHub account couldn't push a fake update.
- **More privacy:** other users can no longer list Ludora names or see when you were online – only your friends can.
- **Riot links can't be hijacked:** an unconfirmed Riot link can no longer replace someone else's, and each Ludora account can claim only one Riot account.
- Server owners: run `supabase/04_vault.sql` and `supabase/05_security.sql` and update the link function (`supabase/functions/link/index.ts`).
- Older Ludora versions can no longer sign in to an account once it has been switched over – just update.

### Downloads
| System | File |
|---|---|
| Windows 10/11 | `Ludora-Setup-0.7.0.exe` |
| macOS (Apple Silicon M1–M4) | `Ludora-0.7.0-arm64.dmg` (or `.zip`) |
| macOS (Intel) | `Ludora-0.7.0-x64.dmg` (or `.zip`) |
| Linux (any distribution) | `Ludora-0.7.0-x86_64.AppImage` |
| Debian / Ubuntu | `Ludora-0.7.0-amd64.deb` |

The files are not code-signed: on Windows click **More info → Run anyway**, on macOS **right-click → Open** on the first start.
[Installation](https://github.com/MaxiMagDich93/ludora#installation) · [Anleitung auf Deutsch](https://github.com/MaxiMagDich93/ludora/blob/main/README.de.md#installation)

---

**Deutsch:** Ludora merkt sich deine Anmeldungen und nimmt sie Ende-zu-Ende-verschlüsselt auf deine anderen Geräte mit (einmal bei Ludora anmelden, überall drin). Dazu Sicherheits-Update – dein Ludora-Passwort verlässt dein Gerät nie mehr, Updates werden nur noch mit signierter Prüfsumme installiert, niemand außer deinen Freunden sieht deine Online-Zeiten, Riot-Verknüpfungen lassen sich nicht mehr kapern. Server: `supabase/04_vault.sql` und `05_security.sql` ausführen und die Prüf-Funktion aktualisieren.

Ludora is not affiliated with Valve, Epic Games, GOG, EA, Ubisoft, Blizzard, Riot Games, Rockstar Games or Amazon.

# Privacy – Ludora

**English** · [Deutsch](PRIVACY.de.md)

_As of November 2026 · Responsible for the Ludora server: **Moxyboxyy** · Contact: [MaxiMagDich@hotmail.com](mailto:MaxiMagDich@hotmail.com)_

Ludora is a desktop app. Most data stays on your device. This document explains what goes where.

## 1. On your device

| Data | Why | Where |
|---|---|---|
| Settings, favorites, own covers, cached library | so Ludora starts fast and remembers your choices | Ludora data folder (`%APPDATA%\Ludora`, `~/Library/Application Support/Ludora`, `~/.config/Ludora`) |
| Sign-in tokens for Steam, Epic, GOG and Ludora | friends lists, account linking | encrypted with your operating system's key store |
| Login cookies (optional, e.g. Battle.net) | library from the account | separate, isolated browser session in the data folder |

Ludora also reads local files of the installed launchers (install lists, download logs). This data never leaves your
device.

**Ludora never sees your launcher passwords** – sign-ins always happen on the provider's real page.

## 2. To the launchers and stores

When you use the respective feature, Ludora talks directly to the provider with your sign-in: Steam (Valve), Epic
Games, GOG, Riot Games (local only), Battle.net (only if enabled). Their privacy policies apply.

The **store** sends your search terms to Steam, Epic Games, GOG and CheapShark and loads images and icons directly
from the stores. With a **SteamGridDB key**, game names are sent to SteamGridDB to find covers.

## 3. To the Ludora server (only with a Ludora account)

A Ludora account is optional. If you create one, the server (Supabase, region per project, e.g. Frankfurt) stores:

- your Ludora name and display name,
- a hash of a value derived from your password – **your password itself never leaves your device** (Ludora sends
  only a value derived from it with scrypt, which Supabase stores as a hash),
- the IDs and names of the launcher accounts you link (Steam, Epic, GOG, Riot),
- your Ludora friendships and requests,
- when Ludora was last online (for “Online in Ludora”),
- an **end-to-end encrypted** block with your Steam, Epic and GOG sign-ins, so you are signed in there on your
  other devices too. It is encrypted on your device with a key derived from your Ludora password; the server (and
  whoever runs it) cannot read it. It is deleted together with your account.

**Who sees what?**
- Your Ludora **friends** see all accounts you linked and whether you're online in Ludora.
- Nobody else can list Ludora names or online times – your profile is readable only by you.
- Other signed-in Ludora users can only ask for a **specific** launcher account ID which Ludora name it belongs to
  (Ludora does this for the accounts in their friends lists). The server never hands out a list of all users or accounts.
- Launcher sign-in tokens are only used briefly to verify with the provider; apart from the encrypted block above,
  which only you can read, they are not stored on the server.

**Deletion:** You can remove links in Ludora at any time. Delete the whole account under Ludora account →
**Delete account …** – name, links and friendships are removed from the server immediately.
Questions: [MaxiMagDich@hotmail.com](mailto:MaxiMagDich@hotmail.com).

## 4. Your rights

You have the right to access, rectification, erasure, restriction of processing and data portability, and to lodge a
complaint with a data protection supervisory authority (Art. 15–21, 77 GDPR).

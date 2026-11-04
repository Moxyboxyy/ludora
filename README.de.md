# Ludora - the Client for all Game Clients

[English](README.md) · **Deutsch**

Ludora holt alle deine PC-Spiele aus **Steam, Epic Games, GOG, EA app, Ubisoft Connect, Battle.net, Amazon Games,
Riot Games und Rockstar** in **eine** App. Du siehst deine ganze Bibliothek an einem Ort, startest, aktualisierst und
deinstallierst Spiele mit einem Klick, verfolgst jeden Download live, siehst deine Freunde aller Plattformen in einer
Liste und durchsuchst alle Stores nach Spielen und Angeboten – während die einzelnen Launcher unsichtbar im
Hintergrund bleiben.

> **Hinweis:** Ludora ist ein privates Open-Source-Projekt und **nicht** mit Valve, Epic Games, GOG, Electronic Arts,
> Ubisoft, Blizzard Entertainment, Riot Games, Rockstar Games oder Amazon verbunden, von ihnen unterstützt oder
> geprüft. Alle Namen, Logos und Marken gehören ihren jeweiligen Inhabern. Gekauft wird immer direkt im jeweiligen
> Store. Siehe [Rechtliches & Risiken](#rechtliches--risiken).

## Inhalt

- [Was Ludora macht](#was-ludora-macht)
- [Installation](#installation)
- [Erste Schritte – Client-Anleitung](#erste-schritte--client-anleitung)
- [Unterstützte Launcher](#unterstützte-launcher)
- [Datenschutz](#datenschutz)
- [Rechtliches & Risiken](#rechtliches--risiken)
- [Für Entwickler](#für-entwickler)
- [Lizenz](#lizenz)

## Was Ludora macht

| Funktion | Was das bedeutet |
|---|---|
| **Eine Bibliothek** | Alle installierten Spiele aller Launcher – dazu gekaufte, aber nicht installierte Spiele, wo der Launcher sie liefert – mit Covern, Spielzeit und „zuletzt gespielt“. Raster- oder Listenansicht, Filter und Sortierung. |
| **Spielen, Updaten, Deinstallieren** | Ein Klick startet das Spiel über seinen eigenen Launcher, der dabei versteckt im Hintergrund startet. Updates und Deinstallationen laufen ebenfalls über die Launcher – unsichtbar, wo der Launcher das zulässt. |
| **Downloads** | Fortschritt, Geschwindigkeit und Restzeit jedes laufenden Downloads und Updates – live, aus allen Launchern in einer Liste. |
| **Favoriten** | Markiere jedes Spiel mit einem Stern – egal aus welchem Launcher – und finde es unter „Favoriten“. |
| **Freunde** | Steam-, Riot-, Epic- und GOG-Freunde in einer Liste, inklusive was sie gerade spielen. Mit Steam-Freunden direkt in Ludora chatten. |
| **Ludora-Konto (optional)** | Freunde, die auch Ludora nutzen, sehen alle deine Launcher-Konten als **eine Person** und können dich über deinen Ludora-Namen hinzufügen. |
| **Shop & Angebote** | Alle Stores auf einmal durchsuchen. Jedes Spiel zeigt, in welchen Stores du es kaufen kannst; ein Klick öffnet die Spielseite im Store (bzw. im Launcher). „Angebote“ zeigt nur reduzierte Spiele. |
| **Tray** | Ludora läuft beim Schließen des Fensters im Hintergrund weiter (Symbol neben der Uhr bzw. in der Menüleiste), wie andere Launcher auch. Startet auf Wunsch mit dem System. |
| **Sprachen** | Englisch (Standard) und Deutsch, umschaltbar in den Einstellungen. |

Ludora sieht deine Launcher-Passwörter nie: Die Anmeldung läuft immer über die echte Seite des Anbieters, und
Anmelde-Tokens werden nur verschlüsselt auf deinem PC gespeichert.

## Installation

Lade die Datei für dein System aus dem [**neuesten Release**](https://github.com/MaxiMagDich93/ludora/releases/latest) herunter.

### Windows 10 / 11

1. **`Ludora-Setup-<version>.exe`** herunterladen.
2. Doppelklick. Der Installer ist nicht signiert, deshalb zeigt Windows SmartScreen evtl. „Der Computer wurde durch
   Windows geschützt“ – auf **Weitere Informationen → Trotzdem ausführen** klicken.
3. Installationsordner wählen und **Installieren** klicken. Ludora bekommt eine Startmenü- und Desktop-Verknüpfung
   und startet danach.
4. Deinstallieren über **Einstellungen → Apps** in Windows. Deine Spiele bleiben unberührt.

### macOS (ab 12 Monterey)

1. **`Ludora-<version>-mac-AppleSilicon.zip`** für Macs mit M1/M2/M3/M4-Chip oder
   **`Ludora-<version>-mac-Intel.zip`** für Intel-Macs herunterladen ( → *Über diesen Mac* zeigt, welcher es ist).
2. Zip doppelklicken und **Ludora.app** in **Programme** ziehen.
3. Die App ist nicht von Apple beglaubigt. Beim ersten Start **Rechtsklick auf Ludora → Öffnen → Öffnen**
   (oder *Systemeinstellungen → Datenschutz & Sicherheit → Dennoch öffnen*).
4. macOS fragt einmal, ob Ludora „System Events“ steuern darf – erlauben, damit Ludora Launcher-Fenster ausblenden kann.

### Linux (x64)

- **AppImage (jede Distribution):** **`Ludora-<version>-x86_64.AppImage`** herunterladen,
  `chmod +x Ludora-*.AppImage` ausführen und per Doppelklick oder `./Ludora-*.AppImage` starten.
- **Debian / Ubuntu:** **`Ludora-<version>-amd64.deb`** herunterladen und `sudo apt install ./Ludora-*-amd64.deb`
  ausführen. Ludora erscheint dann im App-Menü.

Unter Linux gibt es die meisten Launcher nicht. Ludora liest deshalb die zwei Programme, die Linux-Spieler stattdessen nutzen: **[Heroic](https://heroicgameslauncher.com)** (Epic Games, GOG, Amazon) und **[Lutris](https://lutris.net)** (Battle.net, EA app, Ubisoft Connect, Rockstar und alles andere). Spiele dort einmal installieren – Ludora zeigt sie in einer Bibliothek und startet sie. Normale und Flatpak-Installationen werden erkannt. Riot-Spiele (Valorant, League of Legends) laufen wegen Riots Anti-Cheat nicht unter Linux.

## Erste Schritte – Client-Anleitung

### 1. Erster Start
Ludora sucht auf deinem PC nach installierten Launchern und Spielen – ohne Anmeldung. Launcher mit Spielen erscheinen
links unter **Launcher**, nicht installierte unter **Nicht installiert**. Ludora merkt sich deine Bibliothek, spätere
Starts gehen also sofort, während im Hintergrund neu eingelesen wird.

### 2. Das Fenster
- **Leiste oben:** das Menü **Ludora** (Konto, Bibliothek neu einlesen, Einstellungen, Über Ludora, Beenden), die
  Bereiche **Bibliothek** und **Shop** und rechts dein **Ludora-Konto**.
- **Seitenleiste:** *Alle Spiele*, *Favoriten* und ein Eintrag pro Launcher. Der kleine Knopf neben einem Launcher
  öffnet diesen Launcher. Unten: **Downloads** und **Spiel hinzufügen**. Der Knopf neben „Bibliothek“ klappt die
  Seitenleiste auf Symbole zusammen.
- **Unten rechts:** der runde **Freunde**-Knopf mit der Anzahl der Freunde online.

### 3. Bibliothek
- Zwischen **Installiert / Alle / Nicht installiert** wechseln, nach Name, Spielzeit oder zuletzt gespielt sortieren,
  oben suchen und zwischen **Raster / Liste** umschalten.
- Mit der Maus über ein Spiel: **Spielen** (oder **Installieren** / **Update**), Stern = Favorit,
  Ordner = Installationsordner öffnen, Bild = Cover ändern, Mülleimer = deinstallieren.
- Ein grünes **Läuft** zeigt laufende Spiele – ein Klick holt das Spiel nach vorne.

### 4. Updates & Downloads
- Spiele mit Update zeigen **Update**. Ludora startet den Launcher unsichtbar und lässt ihn laden.
- **Downloads** (unten links) zeigt alles, was lädt, pausiert ist oder wartet – mit %, Geschwindigkeit und Restzeit.
  Wo ein Launcher Pausieren nur in seinem eigenen Fenster erlaubt, öffnet der Knopf genau diese Ansicht.

### 5. Eigene Spiele hinzufügen
**Spiel hinzufügen** nimmt jede `.exe`, `.lnk`, `.url` oder `.bat` (Windows) bzw. `.app` (Mac), optional mit
Startparametern – für Spiele ohne Launcher oder Emulatoren.

### 6. Shop & Angebote
- Oben **Shop** öffnen. Ohne Suche siehst du Bestseller und Neuheiten aus allen Stores; tippen durchsucht alle Stores
  gleichzeitig.
- Die Symbole an jedem Spiel zeigen, wo du es kaufen kannst – ein Klick öffnet die Spielseite in diesem Store (im
  Launcher, wenn er installiert ist). Spiele, die du schon besitzt, sind mit **In deiner Bibliothek** und dem Logo des
  Launchers markiert, in dem du sie besitzt.
- Mit den Store-Knöpfen nur einen Store zeigen, **Angebote** für reduzierte Spiele, die Sortierung neben „Shop“ und
  der Raster/Listen-Schalter.

### 7. Freunde
- Runden Knopf unten rechts anklicken. Reiter: **Alle**, **Ludora**, **Steam**, **Riot**, **Epic**, **GOG**.
- **Steam:** einmal per QR-Code mit der Steam-App auf dem Handy anmelden. **Epic / GOG:** einmal auf deren echter Seite
  anmelden. **Riot:** braucht den laufenden Riot Client – Ludora kann ihn versteckt starten.
- Rechtsklick auf einen Freund für Aktionen: Chat, Spiel beitreten, Profil ansehen oder mehrere Konten zu einer Person
  zusammenfassen.

### 8. Ludora-Konto (optional)
Oben rechts auf **Anmelden** (bzw. deinen Namen) klicken und ein Konto mit **Name und Passwort** anlegen – ohne
E-Mail. Ludora verknüpft dann deine angemeldeten Launcher-Konten automatisch, sodass dich Freunde mit Ludora auf jeder
Plattform erkennen. Freunde über ihren Ludora-Namen hinzufügen, Anfragen im Reiter **Ludora** annehmen.
**Konto löschen …** entfernt alles vom Server.

### 9. Tray & Einstellungen
- Beim Schließen läuft Ludora im Tray weiter (Symbol neben der Uhr bzw. in der Menüleiste). Klick öffnet Ludora,
  Rechtsklick zeigt Bibliothek, Shop, Downloads, Freunde, deine Favoriten und **Ludora beenden**.
- **Einstellungen** (Menü Ludora): Sprache, im Hintergrund weiterlaufen, mit dem System starten, wie sich Launcher
  beim Spielstart verhalten (versteckt / minimiert / normal), welche Launcher gelesen werden, optionaler Steam-API-Key
  und SteamGridDB-Key, Bild-Zwischenspeicher.

## Unterstützte Launcher

| Launcher | Windows | macOS | Linux |
|---|---|---|---|
| Steam | ✅ | ✅ | ✅ |
| Epic Games | ✅ | ✅ | ✅ über Heroic |
| GOG Galaxy | ✅ | ✅ | ✅ über Heroic |
| Battle.net | ✅ | ✅ | ✅ über Lutris |
| Riot Games | ✅ | ✅ | – |
| EA app, Ubisoft Connect, Rockstar | ✅ | – | ✅ über Lutris |
| Amazon Games | ✅ | – | ✅ über Heroic |
| Weitere Lutris-Spiele (Emulatoren, GZDoom, …) | – | – | ✅ |
| Eigene Spiele | ✅ | ✅ | ✅ |

Ludora liest die Daten, die die Launcher ohnehin auf deinem PC ablegen (Installationslisten, Manifeste,
Download-Logs), und startet Spiele immer über den Launcher selbst (z. B. `steam://rungameid/<id>`).

## Datenschutz

Kurz: Fast alles bleibt auf deinem PC. Anmelde-Tokens werden mit der Schlüsselverwaltung deines Betriebssystems
verschlüsselt. Ein (optionales) Ludora-Konto speichert nur deinen Ludora-Namen, einen Passwort-Hash, die IDs der
Launcher-Konten, die du verknüpfst, und deine Ludora-Freundschaften. Details: [PRIVACY.de.md](PRIVACY.de.md).

## Rechtliches & Risiken

Neben offiziellen Schnittstellen (z. B. Steam Web API) nutzt Ludora auch **inoffizielle, nicht dokumentierte**
Schnittstellen der Launcher – wie andere Open-Source-Launcher (z. B. Heroic, Legendary, Playnite) auch. Die Anbieter
können diese jederzeit ändern oder sperren. Nutzung auf eigenes Risiko.

- **Steam:** Freunde/Chat über Steams Web-Chat-Schnittstelle ([steam-user](https://github.com/DoctorMcKay/node-steam-user)), Shop-Suche über die Store-Seite.
- **Epic Games / GOG:** Anmeldung, Freunde und Shop über die Schnittstellen der offiziellen Launcher.
- **Riot Games:** nur die lokale Schnittstelle des laufenden Riot Clients (Freunde, Updates).
  *Ludora isn’t endorsed by Riot Games and doesn’t reflect the views or opinions of Riot Games or anyone officially
  involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks
  or registered trademarks of Riot Games, Inc.*
- **Battle.net:** Ludora liest lokale Dateien und setzt für Updates eine Einstellung in `Battle.net.config`. Die
  komplette Bibliothek über die Kontoanmeldung ist **standardmäßig aus** (Einstellungen → Erweitert), weil sie eine
  inoffizielle Schnittstelle nutzt, die laut Blizzard gegen die Nutzungsbedingungen verstoßen kann.
- **Shop:** Preise von Steam, Epic Games und GOG; EA, Ubisoft und Battle.net über [CheapShark](https://www.cheapshark.com).
  Store-Bilder und -Symbole werden zur Laufzeit von den Stores geladen und sind nicht Teil dieses Repositorys.

Ludora verändert keine Spiel-Clients und verschafft keine Vorteile in Spielen.

## Für Entwickler

Voraussetzung: [Node.js](https://nodejs.org) (LTS).

```bash
git clone https://github.com/MaxiMagDich93/ludora.git
cd ludora
npm install
npm run dev
```

| Befehl | Was passiert |
|---|---|
| `npm run dev` | Startet die App mit Live-Reload |
| `npm start` | Baut die Oberfläche und startet die App ohne Dev-Server |
| `npm test` | Führt die Tests aus |
| `npm run dist` | Windows-Installer in `release/` |
| `npm run dist:mac` | Mac-App (auf einem Mac) |

Projektaufbau, neue Launcher und neue Sprachen: siehe [englische README](README.md#for-developers).

### Eigener Ludora-Server (für Ludora-Konten)

Ludora-Konten brauchen ein kleines [Supabase](https://supabase.com)-Projekt (der kostenlose Tarif reicht). Wer Ludora
selbst baut, braucht ein eigenes Projekt:

1. Auf supabase.com ein Projekt anlegen.
2. **SQL Editor:** `supabase/schema.sql`, danach `supabase/02_friends.sql` und `supabase/03_delete_account.sql` ausführen.
3. **Authentication → Sign In / Providers → Email:** „Confirm email“ ausschalten (Ludora-Konten haben keine E-Mail).
4. **Edge Functions:** Funktion mit dem Inhalt von `supabase/functions/link/index.ts` anlegen, „Verify JWT“ ausschalten.
5. `electron/hub-config.example.json` nach `electron/hub-config.json` kopieren und *Project URL*, den **öffentlichen**
   Schlüssel (*anon* / *publishable*) und den Funktionsnamen eintragen. Den *secret*/*service_role*-Schlüssel **nie**
   in die App schreiben. `hub-config.json` wird von Git ignoriert.

Ohne `hub-config.json` funktioniert alles außer den Ludora-Konten. `supabase/test_dummies.sql` legt zwei Test-Profile an.

## Lizenz

[MIT](LICENSE) © 2026 Moxyboxyy

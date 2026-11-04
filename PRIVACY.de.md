# Datenschutz – Ludora

[English](PRIVACY.md) · **Deutsch**

_Stand: November 2026 · Verantwortlich für den Ludora-Server: **Moxyboxyy** · Kontakt: [MaxiMagDich@hotmail.com](mailto:MaxiMagDich@hotmail.com)_

Ludora ist eine Desktop-App. Die meisten Daten bleiben auf deinem Gerät. Dieses Dokument erklärt, was wohin geht.

## 1. Auf deinem Gerät

| Daten | Wozu | Wo |
|---|---|---|
| Einstellungen, Favoriten, eigene Cover, Bibliotheks-Zwischenstand | damit Ludora schnell startet und sich deine Auswahl merkt | Ludora-Datenordner (`%APPDATA%\Ludora`, `~/Library/Application Support/Ludora`, `~/.config/Ludora`) |
| Anmelde-Tokens von Steam, Epic, GOG und Ludora | Freundeslisten, Konto-Verknüpfung | verschlüsselt mit der Schlüsselverwaltung deines Betriebssystems |
| Login-Cookies (optional, z. B. Battle.net) | Bibliothek aus dem Konto | eigene, abgeschottete Browser-Sitzung im Datenordner |

Ludora liest außerdem lokale Dateien der installierten Launcher (Installationslisten, Download-Logs). Diese Daten
verlassen dein Gerät nicht.

**Passwörter der Launcher sieht Ludora nie** – Anmeldungen laufen immer über die echte Seite des Anbieters.

## 2. An die Launcher und Stores

Wenn du die jeweilige Funktion nutzt, spricht Ludora direkt mit dem Anbieter, mit deiner Anmeldung:
Steam (Valve), Epic Games, GOG, Riot Games (nur lokal), Battle.net (nur wenn eingeschaltet). Es gelten deren
Datenschutzbestimmungen.

Der **Shop** schickt deine Suchbegriffe an Steam, Epic Games, GOG und CheapShark und lädt Bilder und Symbole
direkt von den Stores. Mit einem **SteamGridDB-Key** werden Spielnamen an SteamGridDB geschickt, um Cover zu finden.

## 3. An den Ludora-Server (nur mit Ludora-Konto)

Ein Ludora-Konto ist freiwillig. Wenn du eins anlegst, speichert der Server (Supabase, Region laut Projekt, z. B. Frankfurt):

- deinen Ludora-Namen und Anzeigenamen,
- dein Passwort – nur als Hash (von Supabase verschlüsselt),
- die IDs und Namen der Launcher-Konten, die du verknüpfst (Steam, Epic, GOG, Riot),
- deine Ludora-Freundschaften und -Anfragen,
- wann Ludora zuletzt online war (für „Online in Ludora“),
- einen **Ende-zu-Ende-verschlüsselten** Block mit deinen Steam-, Epic- und GOG-Anmeldungen, damit du auf deinen
  anderen Geräten dort gleich mit angemeldet bist. Er wird auf deinem Gerät mit einem Schlüssel aus deinem
  Ludora-Passwort verschlüsselt; der Server (und wer ihn betreibt) kann ihn nicht lesen. Er wird mit dem Konto gelöscht.

**Wer sieht was?**
- Deine Ludora-**Freunde** sehen alle Konten, die du verknüpft hast.
- Andere angemeldete Ludora-Nutzer können nur zu einer **konkreten** Launcher-Konto-ID nachfragen, zu welchem
  Ludora-Namen sie gehört (Ludora tut das für die Konten in deren Freundeslisten). Eine Liste aller Nutzer oder
  Konten gibt der Server nicht heraus.
- Anmelde-Tokens der Launcher werden nur kurz zur Bestätigung beim Anbieter genutzt; außer im verschlüsselten Block
  oben, den nur du lesen kannst, werden sie nicht auf dem Server gespeichert.

**Löschen:** Verknüpfungen kannst du jederzeit in Ludora entfernen. Das ganze Konto löschst du unter
Ludora-Konto → **Konto löschen …** – Name, Verknüpfungen und Freundschaften werden dabei sofort vom Server entfernt.
Bei Fragen: [MaxiMagDich@hotmail.com](mailto:MaxiMagDich@hotmail.com).

## 4. Deine Rechte

Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung und Datenübertragbarkeit
sowie auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde (Art. 15–21, 77 DSGVO).

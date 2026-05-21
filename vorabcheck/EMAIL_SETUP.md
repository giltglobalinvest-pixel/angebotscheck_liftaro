# Liftaro Email-Inbox — Setup-Anleitung

Diese Anleitung beschreibt, wie du den **Email-Empfang** mit KI-Triage einrichtest.
Phase 1 (Email rein → Airtable + KI-Klassifikation). Phase 2 (Inbox-UI im Hauptcheck) und
Phase 3 (Antwort senden mit PDF-Anhang) folgen in separaten Schritten.

---

## Architektur-Überblick

```
┌──────────────────────┐
│ Email an Liftaro     │   z.B. check@liftaro.de
└──────────┬───────────┘
           │ Auto-Forward (Mailclient-Regel)
           ▼
┌──────────────────────┐
│ val.town Email-Val   │   z.B. liftaroinbox@val.email
│ valtown-email.ts     │
└──────────┬───────────┘
           │
           ├─► Claude Haiku 4.5 (Klassifikation + Splitting)
           │
           ▼
┌──────────────────────┐
│ Airtable "Emails"    │   im selben Base wie Vorabcheck
│   + Attachments      │
│   + KI-Vorgänge      │
│   + Status: "neu"    │
└──────────────────────┘
```

---

## Schritt 1: val.town Email-Val anlegen

### Option A — Vollautomatisch via `valdeploy` (empfohlen)

Wenn du das `valdeploy`-Script schon eingerichtet hast (`~/bin/valdeploy`),
musst du nur einmalig den API-Token + Secrets vorbereiten und dann:

```bash
# 1. Einmaliges Setup — API-Token holen + ablegen
mkdir -p ~/.config/valtown
# https://www.val.town/settings/api → "New Token" → Scopes:
#   user:read, vals:read, vals:write, env_vars:read, env_vars:write
printf '%s' "<DEIN-API-TOKEN>" > ~/.config/valtown/token
chmod 600 ~/.config/valtown/token

# 2. Secrets, die in den Val gepusht werden (alle Vals teilen sich diese Datei)
cat > ~/.config/valtown/secrets.json <<'EOF'
{
  "AIRTABLE_KEY":         "patXXX....",
  "AIRTABLE_BASE_ID":     "appXXX....",
  "ANTHROPIC_API_KEY":    "sk-ant-...",
  "EMAIL_INBOX_ENABLED":  "0"
}
EOF
chmod 600 ~/.config/valtown/secrets.json

# 3. Val anlegen + Code pushen + Secrets setzen (alles in einem Schritt)
cd ~/Documents/Liftaro\ GmbH/Anthropic/Angebotscheck/v4.1
~/bin/valdeploy --init liftaroEmailInbox vorabcheck/valtown-email.ts email
```

Das Script gibt dir am Ende die Empfangs-Email-Adresse aus (Format
`<dein-username>-liftaroEmailInbox@valtown.email`).

**Spätere Code-Updates** ohne Argumente: nur Datei pushen, keine Secrets anfassen:

```bash
~/bin/valdeploy liftaroEmailInbox vorabcheck/valtown-email.ts
```

**Nur Secrets neu setzen** (z. B. nach Schlüssel-Rotation):

```bash
~/bin/valdeploy --secrets liftaroEmailInbox
```

**Status anzeigen**:

```bash
~/bin/valdeploy --info liftaroEmailInbox
~/bin/valdeploy --list
```

---

### Option B — Manuell via val.town-Editor

1. Öffne https://www.val.town und logge dich ein
2. Klicke oben rechts auf **"+ New Val"** → wähle **"Email"** als Trigger-Type
3. Benenne den Val z.B. `liftaroEmailInbox`
4. **Code einfügen**: kopiere den kompletten Inhalt von
   `vorabcheck/valtown-email.ts` (aus diesem Repo) in den val.town-Editor.
   - Imports nutzen GitHub-Pages-URLs — keine `npm install` o.ä. nötig.
   - Beim ersten Speichern bemängelt val.town evtl. fehlende Env-Vars (siehe Schritt 3).

5. Speichern → val.town gibt dir eine Email-Adresse, z.B.:
   `pat.liftaroEmailInbox@val.email`
   Die wird oben im Val-Editor angezeigt unter "Email Address".

---

## Schritt 2: Email-Forwarding einrichten

Damit Emails an deine echte Adresse (z.B. `check@liftaro.de`) am Val ankommen,
richte einen automatischen Forward ein.

### Variante A — Mailclient-Regel (Apple Mail / Outlook / Gmail)

- **Apple Mail**: Einstellungen → Regeln → "+" → Bedingung "Jede Nachricht",
  Aktion "Nachricht weiterleiten an" → `pat.liftaroEmailInbox@val.email`
- **Gmail**: Einstellungen → Weiterleitung und POP/IMAP →
  "Eine Weiterleitungsadresse hinzufügen" → bestätigen → Filter erstellen mit
  "Alle Nachrichten weiterleiten an `…@val.email`"
- **Outlook 365**: Posteingangsregel → "Bei allen Nachrichten" →
  Weiterleiten an externe Adresse

### Variante B — Server-Forward beim Mailprovider

Wenn dein Hoster (z.B. Mailbox.org, IONOS) das unterstützt: Trage in der
Mailbox-Konfiguration einen automatischen Forward auf `…@val.email` ein.
Vorteil: Forward läuft 24/7, auch wenn dein Client offline ist.

---

## Schritt 3: Env-Variablen in val.town setzen

Öffne im Val-Editor oben rechts das **Settings**-Tab (Zahnrad) → **Secrets**.
Trage diese vier Werte ein:

| Name                  | Wert                                                              |
|-----------------------|-------------------------------------------------------------------|
| `AIRTABLE_KEY`        | dein Airtable Personal Access Token (gleicher wie der HTTP-Backend)|
| `AIRTABLE_BASE_ID`    | die Base-ID, in der die `Emails`-Tabelle angelegt wird            |
| `ANTHROPIC_API_KEY`   | Claude-Key (gleicher wie main app)                                |
| `EMAIL_INBOX_ENABLED` | `1` (Notbremse — auf `0` setzen, um Empfang sofort zu deaktivieren)|

> **Wichtig:** Setze `EMAIL_INBOX_ENABLED=0`, BEVOR du den Forward aktivierst.
> Erst nach dem ersten Smoke-Test mit einer Test-Email auf `1` stellen.
> Sonst können während der Test-Phase echte Mails ungewollt verarbeitet werden.

---

## Schritt 4: Tabelle "Emails" wird automatisch angelegt

Beim ersten Email-Empfang ruft der Val `ensureEmailsSchema()` auf und legt:

- die Tabelle `Emails` in deinem Airtable-Base an
- alle Spalten gemäß `EMAILS_TARGET_FIELDS` aus `backend-extras.js`

Du musst manuell **nichts** in Airtable vorbereiten — beim ersten Email-Eingang
existieren plötzlich Tabelle + Felder.

Wenn du das Schema später erweiterst (z.B. neue Felder in `backend-extras.js`):
Beim nächsten Email-Empfang werden fehlende Felder automatisch nachgezogen.

---

## Schritt 5: Smoke-Test

1. Setze `EMAIL_INBOX_ENABLED=1` in val.town-Secrets
2. Schicke eine Test-Email von einem **anderen** Postfach an deine val.email-Adresse
   (z.B. `pat.liftaroEmailInbox@val.email` direkt — Forward muss noch nicht aktiv sein)
   - Subject: `TEST: Wartungsvertrag prüfen Mustergasse 12`
   - Body: ein paar Sätze + (optional) ein PDF-Anhang
3. In val.town: Tab **"Logs"** öffnen → sollte zeigen:
   - `[Emails] Empfangen: { ... subject: "TEST: ..." ... }`
   - `[Emails] Verarbeitet OK: rec... — wartung (1 Vorgänge)`
4. In Airtable: Tabelle `Emails` öffnen → 1 neuer Record sichtbar mit
   - `ki_summary`, `ki_classification`, `ki_confidence` befüllt
   - `vorgaenge_json` mit Array
   - Anhänge im `attachments`-Feld
5. Wenn das durchläuft: **Forward in deinem Mailclient aktivieren** →
   Production-Empfang läuft.

---

## Schritt 6: Kosten-Überwachung

In Airtable kannst du eine Summary-Ansicht auf das Feld `ki_cost_eur` bauen,
um den monatlichen KI-Aufwand zu sehen. Erwartung mit Haiku 4.5:

- Pro Email: ~0,001–0,005 € (≈ 1 Cent pro 200–1000 Emails)
- Bei 500 Emails/Monat: ~1–5 € KI-Kosten
- val.town-Plan: kostenlos bis 10k Email-Empfänge/Monat

---

## Wenn etwas schiefläuft

### Email kommt nicht an
- val.town Logs prüfen — taucht der Empfang gar nicht auf?
- Forward im Mailclient testen mit "Test forward" oder eigener Reply-Adresse
- val.email-Adressen ablehnen manchmal Mails ohne `From`-Header

### `EMAIL_INBOX_ENABLED!=1` im Log
- Secret in val.town nicht gesetzt oder falsch geschrieben
- Nach Änderung des Secrets: Val 1× manuell speichern → Re-Init

### `Schema-Ensure FAIL`
- `AIRTABLE_KEY`/`AIRTABLE_BASE_ID` falsch oder ohne Meta-API-Rechte
- PAT braucht **`schema.bases:write`** Scope für Tabellen-/Feldanlage

### `KI-Triage FAIL`
- `ANTHROPIC_API_KEY` falsch
- Limit erreicht → Anthropic Console prüfen

### Attachment fehlt im Airtable-Record
- `content.airtable.com`-Endpoint braucht aktuelles Airtable-PAT (>= 2024)
- Maximalgröße 20 MB pro Anhang — größere werden geskippt (Log-Eintrag)

---

## Was kommt als Nächstes (Phase 2)

1. **Inbox-UI** im Hauptcheck (`index.html`): neue Nav-Pille "Email-Inbox" mit Badge
2. Pro Email: Klick öffnet Modal mit
   - Email-Body-Preview
   - KI-Vorgangs-Vorschläge mit "✓ Übernehmen" / "✗ Verwerfen" pro Vorgang
   - "Übernehmen" → erstellt einen Check-Record im App-Base (vorausgefüllt aus KI-Daten)
3. Anhänge aus Email-Record werden automatisch als Upload in den neuen Check übernommen

## Phase 3 (später)

- DNS-Setup für `check@liftaro.de` (DKIM/SPF via Postmark)
- "Antwort senden"-Button im Check-Detail nach PDF-Fertigstellung
- KI generiert Anschreiben, Bearbeiter editiert + sendet ab, PDF im Anhang
- Email-Record wird auf `status: "geantwortet"` gesetzt

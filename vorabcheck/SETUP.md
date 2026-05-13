# Liftaro Vorabcheck — Setup

Public Landing-Page für KI-gestützten Vorabcheck von Nebenkosten­abrechnungen, Angeboten und Wartungsverträgen.

## Architektur

```
[Browser]                          [GitHub Pages]                     [val.town]                   [Airtable]
                                                                                                
End-User füllt    ──HTTPS──▶  pruefen.liftaro.de   ──HTTPS──▶  liftaroVorabcheck   ──HTTPS──▶  3 Tabellen
das 4-Step-Form        POST    vorabcheck/index.html              (HTTP-Endpoint)        - Vorabcheck-Leads (PII)
hoch                                                                                          - Vorab-Checks (anonym)
                                                                                              - API-Cost-Log
                                                                  ↓
                                                          [Anthropic Claude API]
```

## Schritt-für-Schritt-Setup

### 1. val.town-Account & Endpoint anlegen

1. Account auf https://www.val.town anlegen (kostenlos)
2. „New Val" → „HTTP val" wählen, Name: `liftaroVorabcheck`
3. Code aus `valtown-backend.ts` einfügen
4. Im val.town **Secrets-Tab** folgende Variablen anlegen:
   - `ANTHROPIC_KEY` — euer Anthropic API Key (sk-ant-…)
   - `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile Secret (optional, später)
   - `AIRTABLE_KEY` — Airtable Personal Access Token
   - `AIRTABLE_BASE_ID` — Base-ID (beginnt mit `app…`)
5. Val deployen → HTTP-URL kopieren (Format: `https://USERNAME-liftaroVorabcheck.web.val.run`)

### 2. Airtable-Tabellen anlegen

In eurer existierenden Airtable-Base **drei neue Tabellen** erstellen:

**Tabelle „Vorabcheck-Leads"** (PII):
- `check_nr` (Single line text)
- `check_type` (Single line text)
- `vorname`, `nachname`, `email`, `telefon`, `adresse` (Single line text)
- `file_name` (Single line text)
- `savedAt` (Single line text, ISO-Datum)

**Tabelle „Vorab-Checks"** (anonymisiert):
- `check_nr` (Single line text)
- `check_type`, `ampel`, `summary` (Single line text)
- `savings_estimate_eur` (Number)
- `findings_json`, `anonymized_data_json` (Long text)
- `savedAt` (Single line text)

**Tabelle „API-Cost-Log"**:
- `check_nr`, `endpoint`, `model` (Single line text)
- `tokens_in`, `tokens_out` (Number)
- `cost_eur` (Number, 4 Dezimalstellen)
- `duration_ms` (Number)
- `savedAt` (Single line text)

### 3. Cloudflare Turnstile (optional, gegen Bots)

1. Konto auf https://www.cloudflare.com (kostenlos)
2. „Turnstile" → „Add Site" → Domain `pruefen.liftaro.de`
3. „Site Key" und „Secret Key" notieren
4. Site-Key ins Frontend (`index.html`, oben im Script-Block: `TURNSTILE_SITE_KEY`)
5. Secret-Key in val.town als Secret `TURNSTILE_SECRET_KEY`

Solange noch nicht eingerichtet: der Captcha-Block wird im Frontend übersprungen, val.town akzeptiert den Call auch ohne Token.

### 4. Frontend konfigurieren

In `vorabcheck/index.html` oben im `<script>`-Block diese beiden Konstanten setzen:

```js
const LIFTARO_API_URL = 'https://USERNAME-liftaroVorabcheck.web.val.run';
const TURNSTILE_SITE_KEY = '0x4AAAAAAA_DEIN_SITE_KEY';
```

Alternativ ohne Code-Änderung — via `window`-Globals vor dem Script:
```html
<script>
  window.LIFTARO_API_URL = 'https://...';
  window.TURNSTILE_SITE_KEY = '0x4AAAAAAA...';
</script>
```

### 5. Domain via CNAME einrichten

Im Repo unter `vorabcheck/` (oder Root, je nach Strategie):

**Option A — Subdomain (empfohlen)**
- DNS-Eintrag bei eurem Provider:
  - `CNAME pruefen → giltglobalinvest-pixel.github.io`
- GitHub Pages Settings → Custom Domain: `pruefen.liftaro.de` → "Enforce HTTPS"
- GitHub stellt automatisch Let's-Encrypt-Zertifikat aus (5–60 Min)

**Option B — eigene Domain**
- A-Records für GitHub Pages-IPs (185.199.108.153 etc.)
- Sonst wie Option A

### 6. Testen

1. Browse zu deiner Domain (oder direkt zur GitHub-Pages-URL)
2. Check-Typ auswählen → Datei hochladen → Form ausfüllen → "Analyse starten"
3. In val.town Logs prüfen ob Request ankam
4. In Airtable die drei Tabellen prüfen (Leads, Vorab-Checks, Cost-Log)

## Kosten-Tracking

Jeder Call landet in `API-Cost-Log` mit:
- Tokens In/Out
- Berechneter Kostenrate (Sonnet 4.5: 3 $ / 15 $ pro 1M Tokens, in EUR umgerechnet)
- Dauer

Filter / Pivot in Airtable möglich nach Tag/Monat → Kosten-Übersicht für Liftaro.

## DSGVO

- **Lead-Daten** (mit PII) sind getrennt von Vorab-Check-Daten (anonymisiert)
- PDF-Dateien werden in der ersten Version nicht in Airtable gespeichert (nur file_name)
  → wenn ihr PDFs speichern wollt, später als Airtable-Attachment-Feld + Cron für Auto-Delete nach 30 Tagen
- Consent ist Pflicht (Checkbox im Frontend, vom Backend geprüft)
- Bei DSGVO-Löschanfrage: nur den Lead-Datensatz löschen, anonyme Statistiken bleiben

## Wo bin ich jetzt?

- ✅ Frontend (`vorabcheck/index.html`) — bereit
- ✅ Backend-Vorlage (`valtown-backend.ts`) — zum Reinkopieren in val.town
- ⏳ val.town-Account anlegen, Code einfügen, Secrets setzen
- ⏳ Airtable-Tabellen anlegen
- ⏳ (optional) Turnstile-Account
- ⏳ DNS / CNAME setzen
- ⏳ `LIFTARO_API_URL` im Frontend eintragen

## Endpoints

- **Frontend**: `https://giltglobalinvest-pixel.github.io/angebotscheck_liftaro/vorabcheck/`
  (später dann via CNAME: `https://pruefen.liftaro.de`)
- **Backend**: `https://USERNAME-liftaroVorabcheck.web.val.run`

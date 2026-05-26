// Liftaro Vorabcheck — Backend-Extras (HTTP-Import vom val.town-Backend wegen 80k-Limit)
// Enthält statische Konstanten/Schemas, die das Backend selbst nicht inline haben muss.

// Shared Field-Options
const DT = { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'Europe/Berlin' };
const CB = { icon: 'check', color: 'greenBright' };
// Field-Helpers
const T = n => ({ name: n, type: 'singleLineText' });
const M = n => ({ name: n, type: 'multilineText' });
const D = n => ({ name: n, type: 'dateTime', options: DT });
const C = n => ({ name: n, type: 'checkbox', options: CB });
const N = (n, p) => ({ name: n, type: 'number', options: { precision: p } });
const S = (n, c) => ({ name: n, type: 'singleSelect', options: { choices: c.map(x => ({ name: x })) } });

// Ziel-Schema für Vorab-Checks-Tabelle: alle Felder, die der vollständige Workflow braucht
// (HV-Antwort, strukturierte Vertragsdaten, Bearbeiter-Inbox, Folge-Check-Verknüpfung).
// Wird vom Backend in `ensure_vorabcheck_schema` per Meta-API automatisch angelegt.
export const VORABCHECK_TARGET_FIELDS = [
  // Vorabcheck-Standard-Felder (vom Vorabcheck-Submit & patch_objekt_adresse) — V9.84
  T('objekt_adresse'),
  N('aufzug_count', 0), N('parteien_count', 0),
  N('aufzug_gesamtkosten_eur', 2), N('kosten_pro_aufzug_eur', 2),
  N('savings_estimate_eur', 0), N('savings_total_eur', 0), N('savings_individual_eur', 0),
  T('ampel'), M('summary'), T('check_type'), T('role'),
  M('findings_json'), M('anonymized_data_json'),
  M('aufzug_positionen_text'), M('aufzug_positionen_json'),
  // HV-Daten aus Eigentümer-CTA (submit_eigentuemer_cta)
  T('hv_name'), T('hv_email'), T('hv_telefon'), T('hv_adresse'), T('hv_website'),
  T('hv_pipedrive_org_id'),
  // Pipedrive-Lead-Verknüpfung
  T('pipedrive_lead_id'), T('pipedrive_person_id'),
  // HV-Antwort (Verwalter-Landing)
  S('verwalter_status', ['offen', 'antwort_erhalten']),
  T('verwalter_name'), T('verwalter_email'), T('verwalter_telefon'),
  T('verwalter_firma_name'), T('verwalter_objekt_adresse'),
  T('verwalter_response_mode'), D('verwalter_response_at'), M('verwalter_response_json'),
  { name: 'verwalter_response_pdf', type: 'multipleAttachments' },
  T('verwalter_response_pdf_name'),
  // Strukturierte Vertragsdaten — aus Konfig (mode='fragen') oder PDF-KI (mode='upload')
  T('vertrag_wartungen_pro_jahr'), T('vertrag_wartungstyp'),
  C('vertrag_tuev_begleitung'), C('vertrag_tuev_pruefung'), C('vertrag_notruf'), C('vertrag_entstoerung'),
  T('vertrag_vertragsbeginn'),
  N('vertrag_kuendigungsfrist_monate', 0), N('vertrag_jahresbeitrag_eur', 2),
  N('vertrag_anzahl_aufzuege', 0), N('vertrag_mindestlaufzeit_jahre', 1),
  D('vertrag_extracted_at'), T('vertrag_extracted_source'), M('vertrag_raw_json'),
  // Bearbeiter-Inbox
  S('bearbeiter_status', ['offen', 'in_bearbeitung', 'erledigt']),
  D('bearbeiter_status_at'), T('bearbeiter_name'),
  // Folge-Check-Verknüpfung
  T('linked_check_id'), T('linked_check_requestid'), T('linked_check_type'),
  T('linked_check_ersparnis'), D('linked_check_at'),
];

// String-Keys für die PDF-Extraction (Vertrags-Extraction-JSON → Airtable-Mapping):
// Werte mit diesen Keys werden im Backend als String gespeichert (nicht als Number),
// weil Airtable für vertrag_wartungstyp/vertragsbeginn Single-Line-Text-Felder hat.
export const VERTRAG_EXTRACT_STRING_KEYS = ['vertragsbeginn', 'wartungen_pro_jahr', 'wartungstyp'];

// ──────────────────────────────────────────────────────────────────
// Email-Inbox: Schema für die "Emails"-Tabelle in Airtable.
// Eine Email pro Record. Vorgänge (1..N nach KI-Splitting) leben als JSON
// im Feld `vorgaenge_json` UND werden zusätzlich als Light-Index in den
// Status-Feldern aggregiert, damit Filter-Views in Airtable funktionieren.
// ──────────────────────────────────────────────────────────────────
export const EMAILS_TARGET_FIELDS = [
  // Empfangs-Header — bei Forward: Original-Absender (extrahiert aus Body)
  T('from_email'), T('from_name'),
  T('to_email'), T('reply_to'),
  T('subject'),
  D('received_at'),
  T('message_id'), T('in_reply_to'),
  // Forward-Metadaten (wenn manuell von check@liftaro.de weitergeleitet)
  C('is_forwarded'),
  T('forwarded_via'),      // Adresse, über die weitergeleitet wurde (z.B. check@liftaro.de)
  T('raw_from_email'),     // Was wirklich im SMTP-FROM stand
  T('raw_from_name'),
  T('raw_subject'),        // Original-Subject mit "Fwd: ..."-Prefix
  // Body (raw)
  M('body_text'), M('body_html'),
  // Attachments — Airtable speichert Datei direkt + Anzahl als Index
  { name: 'attachments', type: 'multipleAttachments' },
  N('attachment_count', 0),
  M('attachment_debug'),    // JSON-Snapshot der att-Objekt-Struktur (Diagnose-Feld)
  // KI-Analyse
  M('ki_summary'),               // Kurzfassung der Email für Inbox-Liste
  S('ki_classification', ['wartung', 'reparatur', 'rechnung', 'korrespondenz', 'multiple', 'unklar', 'spam']),
  N('ki_vorgaenge_count', 0),    // wie viele Check-Vorgänge die KI gefunden hat
  M('vorgaenge_json'),           // Array der erkannten Vorgänge (JSON-String)
  M('reply_draft'),              // KI-Antwortvorschlag bei "korrespondenz"
  T('ki_confidence'),            // low/medium/high
  D('ki_analyzed_at'),
  T('ki_model'),
  N('ki_cost_eur', 4),
  // Workflow-Status
  S('status', ['neu', 'gesichtet', 'in_bearbeitung', 'geantwortet', 'verworfen']),
  D('status_at'),
  T('bearbeiter_name'),
  // Verknüpfung zu Checks-Tabelle (in App-Base) — wir speichern Komma-getrennte
  // Check-IDs, weil Cross-Base-Links in Airtable nicht möglich sind
  T('linked_check_ids'),         // "C-2026-0042,C-2026-0043"
  N('linked_checks_count', 0),
  // Reply-Tracking
  D('replied_at'),
  T('replied_subject'),
  M('replied_body'),
  T('reply_postmark_id'),        // Postmark/SES-MessageID der Antwort
];

// ──────────────────────────────────────────────────────────────────
// V12.13 Phase 1: Partner-Plattform — Schemas
// "Partner-Pool"     = Aufzugsunternehmen, an die Liftaro anfragen kann
// "Partner-Anfragen" = einzelne Anfragen Liftaro→Partner (1 pro Partner pro Check)
// ──────────────────────────────────────────────────────────────────

// Partner-Pool: Stammdaten aller Aufzugsunternehmen, mit denen Liftaro arbeitet.
// Liftaro-Admin pflegt die Liste manuell (Phase 5 baut UI dafür).
export const PARTNER_POOL_TARGET_FIELDS = [
  T('partner_id'),               // Slug, z.B. "ahw", "aszendio", "schmitt-aufzug-stuttgart"
  T('name'),                     // Anzeigename, z.B. "Aufzugshandwerk GmbH"
  T('email_kontakt'),            // Mail-Adresse, an die Anfragen gehen
  T('telefon'),                  // optional
  T('website'),                  // optional
  T('plz_region'),               // optional Komma-getrennt: "70-71,89,80" (PLZ-Anfänge)
  T('spezialisierungen'),        // Komma-getrennt: "wartung,reparatur,modernisierung"
  T('api_key'),                  // Kanal 2 (Phase 8): API-Zugriff
  T('webhook_url'),              // Optional: POST hierhin wenn neue Anfrage für Partner kommt
  C('active'),                   // Aktiv-Toggle
  D('created_at'),
  M('notes'),                    // Freitext: Konditionen, Ansprechpartner, etc.
];

// Partner-Anfragen: 1 Eintrag pro (Check × Partner). Pro Check kann es N Anfragen geben.
// Token ist der One-Time-Schlüssel für die Landing-Page (channel='landing').
export const PARTNER_ANFRAGEN_TARGET_FIELDS = [
  T('id'),                       // PA-2026-0001 (auto-generiert)
  T('check_id'),                 // Verlinkung zu Checks (z.B. C_1234) — Text, weil cross-base nicht möglich
  T('partner_id'),
  T('partner_name'),             // Snapshot (für Listen ohne Join)
  T('partner_email'),            // Snapshot
  T('token'),                    // 32-Zeichen URL-safer Token (für Landing-Page)
  T('channel'),                  // "landing" | "api"
  S('status', ['gesendet', 'geoeffnet', 'angeboten', 'abgelehnt', 'timeout']),
  D('sent_at'),
  D('opened_at'),
  D('responded_at'),
  D('deadline_at'),
  // Check-Snapshot (anonymisiert) — was Partner zu sehen bekommt
  T('objekt_plz'),
  T('objekt_ort'),
  T('objekt_strasse'),           // wird je nach Anonymisierungs-Stufe leer gelassen
  T('anzahl_aufzuege'),
  T('anlagenart'),
  M('leistungsumfang_text'),     // KI-extrahiertes Soll-Leistungsbild
  C('include_vorliegendes_pdf'), // Optional pro Anfrage (Antwort 4 aus Strategie)
  { name: 'vorliegendes_pdf_snapshot', type: 'multipleAttachments' },
  // Antwort-Felder (vom Partner befüllt, channel-egal)
  T('response_offer_id'),        // Partner-eigene Angebots-Nr
  T('response_preis_netto'),
  T('response_laufzeit_jahre'),
  T('response_kuendigungsfrist_monate'),
  T('response_wartungen_pro_jahr'),
  C('response_vollwartung'),
  C('response_notruf'),
  C('response_tuev_begl'),
  C('response_tuev_pruef'),
  C('response_entstoerung'),
  M('response_kommentar'),
  { name: 'response_pdf', type: 'multipleAttachments' },
  // V12.42: Generierte Vorabcheck-Auswertung als PDF-Anhang (vom Frontend hochgeladen)
  { name: 'ergebnis_pdf', type: 'multipleAttachments' },
  // Auswahl im Liftaro-Check: wird hier markiert, sobald Bearbeiter die Variante wählt
  C('selected_by_liftaro'),
  D('selected_at'),
];

// ─────────────────────────────────────────────────────────────────────
// V12.42: Vorabcheck-PDF auf Vorab-Checks.ergebnis_pdf hochladen.
// Wird aus valtown-backend.ts via Thin-Wrapper aufgerufen (Code-Auslagerung
// wegen val.town 80k-Char-Limit).
// Args: body = { check_nr, pdf_base64, filename }, env = { AIRTABLE_KEY, AIRTABLE_BASE_ID }
// Returns: { ok, url?, filename?, size?, error? }
// ─────────────────────────────────────────────────────────────────────
export async function handleUploadVorabcheckPdf(body, env) {
  const k = env?.AIRTABLE_KEY;
  const b = env?.AIRTABLE_BASE_ID;
  if (!k || !b) return { ok: false, status: 500, error: 'airtable nicht konfiguriert' };
  const checkNr = String(body.check_nr || '').trim();
  const pdfB64  = String(body.pdf_base64 || '').trim();
  const fname   = String(body.filename || ('Liftaro_Vorabcheck_' + checkNr + '.pdf')).trim();
  if (!checkNr) return { ok: false, status: 400, error: 'check_nr fehlt' };
  if (!pdfB64)  return { ok: false, status: 400, error: 'pdf_base64 fehlt' };
  try {
    const filt = encodeURIComponent("{check_nr}='" + checkNr.replace(/'/g, "\\'") + "'");
    const findRes = await fetch('https://api.airtable.com/v0/' + b + "/Vorab-Checks?filterByFormula=" + filt + '&maxRecords=1',
      { headers: { Authorization: 'Bearer ' + k } });
    if (!findRes.ok) {
      const txt = await findRes.text();
      return { ok: false, status: findRes.status, error: 'Lead-Lookup HTTP ' + findRes.status, raw: txt.slice(0, 200) };
    }
    const findData = await findRes.json();
    const recId = findData.records?.[0]?.id;
    if (!recId) return { ok: false, status: 404, error: 'Vorabcheck-Lead mit check_nr ' + checkNr + ' nicht gefunden' };
    // Sicherstellen dass Feld 'ergebnis_pdf' existiert (best-effort)
    try {
      const schemaRes = await fetch('https://api.airtable.com/v0/meta/bases/' + b + '/tables',
        { headers: { Authorization: 'Bearer ' + k } });
      if (schemaRes.ok) {
        const schema = await schemaRes.json();
        const tbl = schema.tables?.find((t) => t.name === 'Vorab-Checks');
        const hasField = tbl?.fields?.some((f) => f.name === 'ergebnis_pdf');
        if (tbl && !hasField) {
          await fetch('https://api.airtable.com/v0/meta/bases/' + b + '/tables/' + tbl.id + '/fields', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'ergebnis_pdf', type: 'multipleAttachments' }),
          });
        }
      }
    } catch (_) { /* nicht kritisch */ }
    // Attachment hochladen via Airtable Content-API
    const uploadUrl = 'https://content.airtable.com/v0/' + b + '/' + recId + '/ergebnis_pdf/uploadAttachment';
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'application/pdf', file: pdfB64, filename: fname }),
    });
    if (!uploadRes.ok) {
      const txt = await uploadRes.text();
      return { ok: false, status: uploadRes.status, error: 'Upload HTTP ' + uploadRes.status, raw: txt.slice(0, 300) };
    }
    const uploadData = await uploadRes.json();
    const atts = uploadData?.fields?.ergebnis_pdf || [];
    const att  = atts[atts.length - 1];
    if (!att?.url) return { ok: false, status: 500, error: 'URL fehlt in Upload-Response', raw: JSON.stringify(uploadData).slice(0, 300) };
    return { ok: true, url: att.url, filename: att.filename, size: att.size, recordId: recId };
  } catch (e) {
    return { ok: false, status: 500, error: e?.message || String(e) };
  }
}

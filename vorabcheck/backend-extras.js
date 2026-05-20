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


import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import { ROLE_CONTEXTS, DEFAULT_SYSTEM_PROMPTS } from "https://check.liftaro.de/vorabcheck/prompts.js?v=3";
import { VORABCHECK_TARGET_FIELDS } from "https://check.liftaro.de/vorabcheck/backend-extras.js?v=5";

const MODEL = "claude-sonnet-4-6";     // Upgrade von 4.5 → 4.6 für besseres Vision-Verständnis bei Tabellen
const COST_PER_M_INPUT_TOKENS = 3.0;   // $ pro 1M Input-Tokens (Sonnet 4.6 — Preise ähnlich 4.5)
const COST_PER_M_OUTPUT_TOKENS = 15.0; // $ pro 1M Output-Tokens
const USD_TO_EUR = 0.92;

let _promptCache: Record<string, string> | null = null;
let _promptCacheTs = 0;
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

// Airtable PATCH mit Retry-on-Unknown-Field: dropt unbekannte Felder einzeln und probiert nochmal
async function atPatchRetry(url: string, k: string, fields: any, max = 15): Promise<{ ok: boolean, error?: string }> {
  const headers = { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' };
  let a = 0;
  while (a++ < max) {
    const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ fields }) });
    if (r.ok) return { ok: true };
    const txt = await r.text();
    let bad = '';
    try {
      const j = JSON.parse(txt);
      const m = String(j?.error?.message || j?.error || '').match(/Unknown field name:\s*"([^"]+)"/i);
      if (m) bad = m[1];
    } catch (_) {}
    if (bad && Object.prototype.hasOwnProperty.call(fields, bad)) { delete fields[bad]; continue; }
    return { ok: false, error: txt.slice(0, 200) };
  }
  return { ok: false, error: 'too many retries' };
}

async function loadCustomPrompts(): Promise<Record<string, string>> {
  if (_promptCache && Date.now() - _promptCacheTs < PROMPT_CACHE_TTL_MS) return _promptCache;
  const key = Deno.env.get("AIRTABLE_KEY");
  const base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!key || !base) { _promptCache = {}; _promptCacheTs = Date.now(); return _promptCache; }
  try {
    const res = await fetch(`https://api.airtable.com/v0/${base}/Vorabcheck-Prompts`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const map: Record<string, string> = {};
    (data.records || []).forEach((r: any) => {
      const t = r.fields?.check_type;
      const p = r.fields?.system_prompt;
      if (t && p && p.trim().length > 50) map[t] = p;
    });
    _promptCache = map;
    _promptCacheTs = Date.now();
    return map;
  } catch (e) {
    console.warn("loadCustomPrompts:", e);
    return _promptCache || {};
  }
}

const PIPEDRIVE_MASTER_BASE = 'appzhNrhkLSTEaNFW';
const PIPEDRIVE_PROJECT_ID  = 'p_1777239396379';
let _pdCache: { domain: string, token: string } | null = null;
let _pdCacheTs = 0;
const PD_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadPipedriveConfig(): Promise<{ domain: string, token: string } | null> {
  if (_pdCache && Date.now() - _pdCacheTs < PD_CACHE_TTL_MS) return _pdCache;
  const atKey = Deno.env.get("AIRTABLE_KEY");
  if (!atKey) { _pdCacheTs = Date.now(); return null; }
  try {
    const url = 'https://api.airtable.com/v0/' + PIPEDRIVE_MASTER_BASE + '/Keys?filterByFormula=' +
      encodeURIComponent("AND({project_id}='" + PIPEDRIVE_PROJECT_ID + "',OR({key_name}='pipedriveDomain',{key_name}='pipedriveApiToken'))");
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + atKey } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    let domain = '', token = '';
    (data.records || []).forEach((r: any) => {
      if (r.fields?.key_name === 'pipedriveDomain')   domain = String(r.fields.key_value || '').trim();
      if (r.fields?.key_name === 'pipedriveApiToken') token  = String(r.fields.key_value || '').trim();
    });
    _pdCacheTs = Date.now();
    if (!domain || !token) { _pdCache = null; return null; }
    _pdCache = { domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''), token };
    return _pdCache;
  } catch (e) {
    console.warn('[Pipedrive] loadPipedriveConfig:', e);
    return null;
  }
}

async function createPipedriveLead(input: {
  name: string;
  email?: string;
  phone?: string;
  org?: string;
  title: string;
  note: string;
}): Promise<{ ok: boolean; lead_id?: string; person_id?: number; reused?: boolean; error?: string }> {
  return upsertPipedriveLead(input);
}

async function upsertPipedriveLead(input: {
  name: string;
  email?: string;
  phone?: string;
  org?: string;
  title: string;
  note: string;
}): Promise<{ ok: boolean; lead_id?: string; person_id?: number; reused?: boolean; error?: string }> {
  const cfg = await loadPipedriveConfig();
  if (!cfg) return { ok: false, error: 'Pipedrive nicht konfiguriert' };
  const base = 'https://' + cfg.domain + '/api/v1';
  const auth = '?api_token=' + encodeURIComponent(cfg.token);
  try {
    let personId: number | null = null;
    let personExisted = false;

    if (input.email) {
      try {
        const searchUrl = base + '/persons/search?fields=email&exact_match=true&limit=5&term=' +
          encodeURIComponent(input.email) + '&api_token=' + encodeURIComponent(cfg.token);
        const sr = await fetch(searchUrl);
        const sd = await sr.json();
        if (sd?.success && sd.data?.items?.length) {
          personId = sd.data.items[0].item?.id || null;
          if (personId) personExisted = true;
        }
      } catch (e) {  }
    }

    if (!personId) {
      const personBody: any = { name: input.name || 'Anonym' };
      if (input.email) personBody.email = [{ value: input.email, primary: true, label: 'work' }];
      if (input.phone) personBody.phone = [{ value: input.phone, primary: true, label: 'work' }];
      const personRes = await fetch(base + '/persons' + auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(personBody),
      });
      const personData = await personRes.json();
      if (!personData.success) {
        return { ok: false, error: 'Person: ' + JSON.stringify(personData.error || personData).slice(0, 200) };
      }
      personId = personData.data.id;
    }

    let orgId: number | null = null;
    if (input.org && input.org.trim() && !personExisted) {
      try {
        const orgRes = await fetch(base + '/organizations' + auth, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: input.org.trim() }),
        });
        const orgData = await orgRes.json();
        if (orgData.success) orgId = orgData.data.id;
      } catch (e) {  }
    }

    let leadId: string | null = null;
    let leadReused = false;
    try {
      const leadsUrl = base + '/leads?person_id=' + personId + '&archived_status=not_archived&limit=20&api_token=' + encodeURIComponent(cfg.token);
      const lr = await fetch(leadsUrl);
      const ld = await lr.json();
      if (ld?.success && Array.isArray(ld.data) && ld.data.length > 0) {
        const sorted = ld.data.slice().sort((a: any, b: any) =>
          String(b.add_time || '').localeCompare(String(a.add_time || ''))
        );
        leadId = sorted[0].id;
        leadReused = true;
      }
    } catch (e) {  }

    if (!leadId) {
      const leadBody: any = { title: input.title, person_id: personId };
      if (orgId) leadBody.organization_id = orgId;
      const leadRes = await fetch(base + '/leads' + auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leadBody),
      });
      const leadData = await leadRes.json();
      if (!leadData.success) {
        return { ok: false, error: 'Lead: ' + JSON.stringify(leadData.error || leadData).slice(0, 200), person_id: personId };
      }
      leadId = leadData.data.id;
    }

    if (input.note) {
      try {
        const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        const noteWithStamp = '🕒 ' + stamp + '\n\n' + input.note;
        await fetch(base + '/notes' + auth, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: noteWithStamp, lead_id: leadId }),
        });
      } catch (e) {  }
    }

    console.log('[Pipedrive] ' + (leadReused ? 'Lead reused' : 'Lead created') + ':', leadId,
      'person=' + personId + (personExisted ? ' (existed)' : ' (new)'));
    return { ok: true, lead_id: leadId, person_id: personId, reused: leadReused };
  } catch (e: any) {
    return { ok: false, error: 'Exception: ' + (e.message || String(e)) };
  }
}

const HV_GENERIC_EMAIL_PREFIXES = [
  'info', 'kontakt', 'service', 'mail', 'office',
  'verwaltung', 'hausverwaltung', 'team', 'kundenservice',
  'support', 'anfrage', 'post', 'zentrale', 'verwalter',
  'buero', 'hello', 'welcome', 'empfang', 'sekretariat',
  'wohnen', 'immobilien',
];

function isGenericHvEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  const local = e.split('@')[0];
  return HV_GENERIC_EMAIL_PREFIXES.includes(local);
}

function pickGenericEmailFromPersons(persons: any[]): string | null {
  if (!Array.isArray(persons) || !persons.length) return null;
  for (const p of persons) {
    const emails = Array.isArray(p?.email) ? p.email : [];
    for (const e of emails) {
      const val = String(e?.value || '').trim();
      if (isGenericHvEmail(val)) return val;
    }
  }
  return null;
}

async function findPipedriveOrgsByName(name: string, limit = 3): Promise<any[]> {
  const cfg = await loadPipedriveConfig();
  if (!cfg) return [];
  const term = String(name || '').trim();
  if (term.length < 3) return [];
  const termLow = term.toLowerCase();
  const base = 'https://' + cfg.domain + '/api/v1';
  try {
    const url = base + '/organizations/search?term=' + encodeURIComponent(term) +
                '&fields=name&exact_match=false&limit=10&api_token=' + encodeURIComponent(cfg.token);
    const r = await fetch(url);
    const d = await r.json();
    if (!d?.success || !d.data?.items?.length) return [];
    const filtered = d.data.items
      .map((it: any) => ({
        item: it.item,
        score: Number(it.result_score || 0),
      }))
      .filter((x: any) => {
        if (!x.item || !x.item.name) return false;
        const nameLow = String(x.item.name).toLowerCase();
        if (!nameLow.includes(termLow)) return false;
        return x.score >= 0.3 || term.length >= 5; // bei längerem Term Score-Toleranz lockern
      })
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit)
      .map((x: any) => x.item);
    return filtered;
  } catch (e) { console.warn('[Pipedrive] findOrgsByName:', e); return []; }
}

async function findPipedriveOrgByName(name: string): Promise<any | null> {
  const hits = await findPipedriveOrgsByName(name, 1);
  return hits.length ? hits[0] : null;
}

async function getOrgGenericEmail(orgId: number): Promise<string | null> {
  const cfg = await loadPipedriveConfig();
  if (!cfg || !orgId) return null;
  const base = 'https://' + cfg.domain + '/api/v1';
  try {
    const url = base + '/organizations/' + orgId + '/persons?api_token=' + encodeURIComponent(cfg.token);
    const r = await fetch(url);
    const d = await r.json();
    if (!d?.success || !Array.isArray(d.data)) return null;
    return pickGenericEmailFromPersons(d.data);
  } catch (e) { console.warn('[Pipedrive] getOrgGenericEmail:', e); return null; }
}

async function createPipedriveOrgWithEmail(input: {
  name: string;
  email?: string;
  website?: string;
  city?: string;
  source?: string;  // 'manuell' | 'ki_serper' | 'user_verifiziert'
}): Promise<{ ok: boolean; org_id?: number; error?: string }> {
  const cfg = await loadPipedriveConfig();
  if (!cfg) return { ok: false, error: 'Pipedrive nicht konfiguriert' };
  const base = 'https://' + cfg.domain + '/api/v1';
  const auth = '?api_token=' + encodeURIComponent(cfg.token);
  try {
    const orgBody: any = { name: input.name };
    if (input.city) orgBody.address = input.city;
    const orgRes = await fetch(base + '/organizations' + auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orgBody),
    });
    const orgData = await orgRes.json();
    if (!orgData.success) return { ok: false, error: 'Org-Create: ' + JSON.stringify(orgData.error || {}).slice(0, 200) };
    const orgId = orgData.data.id;
    if (input.email && isGenericHvEmail(input.email)) {
      const personBody: any = {
        name: input.name + ' (Allgemein)',
        email: [{ value: input.email, primary: true, label: 'work' }],
        org_id: orgId,
      };
      await fetch(base + '/persons' + auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(personBody),
      }).catch(() => {  });
    }
    return { ok: true, org_id: orgId };
  } catch (e: any) {
    return { ok: false, error: 'Exception: ' + (e.message || String(e)) };
  }
}

async function linkPersonToOrg(personId: number, orgId: number): Promise<boolean> {
  const cfg = await loadPipedriveConfig();
  if (!cfg || !personId || !orgId) return false;
  const base = 'https://' + cfg.domain + '/api/v1';
  const auth = '?api_token=' + encodeURIComponent(cfg.token);
  try {
    const r = await fetch(base + '/persons/' + personId + auth, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId }),
    });
    const d = await r.json();
    return !!d?.success;
  } catch (e) { console.warn('[Pipedrive] linkPersonToOrg:', e); return false; }
}

async function createHvLead(input: {
  orgId: number;
  userFullName: string;
  userEmail?: string;
  savingsTotal?: number;
  checkNr: string;
  role: string;
  hvName: string;
}): Promise<{ ok: boolean; lead_id?: string; error?: string }> {
  const cfg = await loadPipedriveConfig();
  if (!cfg) return { ok: false, error: 'Pipedrive nicht konfiguriert' };
  const base = 'https://' + cfg.domain + '/api/v1';
  const auth = '?api_token=' + encodeURIComponent(cfg.token);
  try {
    let leadId: string | null = null;
    let reused = false;
    try {
      const lr = await fetch(base + '/leads?organization_id=' + input.orgId +
        '&archived_status=not_archived&limit=20&api_token=' + encodeURIComponent(cfg.token));
      const ld = await lr.json();
      if (ld?.success && Array.isArray(ld.data) && ld.data.length > 0) {
        const sorted = ld.data.slice().sort((a: any, b: any) =>
          String(b.add_time || '').localeCompare(String(a.add_time || '')));
        leadId = sorted[0].id;
        reused = true;
      }
    } catch (e) {  }

    if (!leadId) {
      const title = '[HV-Lead] ' + input.hvName + ' — via Vorabcheck ' + input.checkNr;
      const leadBody: any = { title, organization_id: input.orgId };
      const lr = await fetch(base + '/leads' + auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(leadBody),
      });
      const ld = await lr.json();
      if (!ld.success) return { ok: false, error: 'HV-Lead: ' + JSON.stringify(ld.error || {}).slice(0, 200) };
      leadId = ld.data.id;
    }

    const fmt = (n: number) => Math.round(n).toLocaleString('de-DE');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const roleLabel = input.role === 'eigentuemer' ? 'Eigentümer'
                    : input.role === 'verwalter'  ? 'Hausverwalter'
                    :                                'Mieter';
    const noteLines = [
      '🕒 ' + stamp, '', 'HV-Lead aus Liftaro-Vorabcheck',
      'Check-Nr: ' + input.checkNr, 'Auftraggeber: ' + input.userFullName + ' (' + roleLabel + ')',
      input.userEmail ? 'E-Mail: ' + input.userEmail : '',
      input.savingsTotal ? 'Sparpotenzial: ' + fmt(input.savingsTotal) + ' €/Jahr' : '',
      '', 'Follow-up: Einsparungsberechnung + Light-Paket',
    ].filter(Boolean);
    try {
      await fetch(base + '/notes' + auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteLines.join('\n'), lead_id: leadId }),
      });
    } catch (e) {  }

    console.log('[Pipedrive] HV-Lead ' + (reused ? 'reused' : 'created') + ':', leadId, 'org=' + input.orgId);
    return { ok: true, lead_id: leadId };
  } catch (e: any) {
    return { ok: false, error: 'Exception: ' + (e.message || String(e)) };
  }
}

let _preisrefCache: any[] | null = null;
let _preisrefCacheTs = 0;
const PREISREF_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadPreisreferenzen(): Promise<any[]> {
  if (_preisrefCache && Date.now() - _preisrefCacheTs < PREISREF_CACHE_TTL_MS) return _preisrefCache;
  const key = Deno.env.get("AIRTABLE_KEY");
  const base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!key || !base) { _preisrefCache = []; _preisrefCacheTs = Date.now(); return []; }
  try {
    const res = await fetch(`https://api.airtable.com/v0/${base}/Preisreferenzen`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const list = (data.records || []).map((r: any) => ({
      position: r.fields?.position || '',
      einheit:  r.fields?.einheit  || '',
      median_eur: Number(r.fields?.median_eur || 0),
      region:   r.fields?.region   || '',
      notes:    r.fields?.notes    || '',
    })).filter((p: any) => p.position && p.median_eur > 0);
    _preisrefCache = list;
    _preisrefCacheTs = Date.now();
    return list;
  } catch (e) {
    console.warn("loadPreisreferenzen:", e);
    return _preisrefCache || [];
  }
}

function deterministicSavingsFactor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return 0.30 + ((h >>> 0) % 1000) / 1000 * 0.30; // 0,30 – 0,60
}


function buildSystemPrompt(checkType: string, role: string, customMap: Record<string, string>): string | null {
  if (customMap[checkType + '.' + role]) return customMap[checkType + '.' + role];
  if (customMap[checkType]) return customMap[checkType];

  const base = DEFAULT_SYSTEM_PROMPTS[checkType];
  if (!base) return null;
  const roleCtx = ROLE_CONTEXTS[role] || ROLE_CONTEXTS.mieter;
  return roleCtx + '\n\n────────────────────────────────────────\n\n' + base;
}


export default async function (req: Request): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ error: "POST only" }, 405, corsHeaders);

  try {
    const body = await req.json();

    if (body.action === 'contact') {
      const c = body.contact || {};
      const name = String(c.name || '').trim();
      const email = String(c.email || '').trim();
      if (!name || !email) return jsonResp({ ok: false, error: 'name und email sind Pflichtfelder' }, 400, corsHeaders);
      const firma = String(c.firma || '').trim();
      const telefon = String(c.telefon || '').trim();
      const paket = String(c.paket || 'andere').toLowerCase();
      const anzahl = parseInt(String(c.anzahl || '0'), 10) || 0;
      const nachricht = String(c.nachricht || '').trim();
      const paketLabel = paket === 'free' ? 'Free (50% Erfolgsbeteiligung)'
                      : paket === 'light' ? 'Light (45 €/Monat je Aufzug)'
                      : 'Andere / unklar';

      try {
        const atKey = Deno.env.get("AIRTABLE_KEY");
        const atBase = Deno.env.get("AIRTABLE_BASE_ID");
        if (atKey && atBase) {
          await fetch('https://api.airtable.com/v0/' + atBase + '/Kontakt-Anfragen', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + atKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: {
                name, email,
                firma: firma || '',
                telefon: telefon || '',
                paket: paketLabel,
                anzahl_aufzuege: anzahl,
                nachricht: nachricht || '',
                savedAt: new Date().toISOString(),
              },
            }),
          });
        }
      } catch (e: any) { console.warn('[Kontakt] Airtable failed:', e.message); }

      const noteLines = [
        'Quelle: Startseite Kontakt-Formular',
        'Paket-Interesse: ' + paketLabel,
        anzahl ? 'Anzahl Aufzüge: ' + anzahl : 'Anzahl Aufzüge: –',
        'Firma / Hausverwaltung: ' + (firma || '–'),
        'Telefon: ' + (telefon || '–'),
        '',
        '— Nachricht —',
        nachricht || '(keine)',
      ];
      const pd = await createPipedriveLead({
        name,
        email,
        phone: telefon || undefined,
        org: firma || undefined,
        title: '[Inbound] ' + name + ' — ' + paketLabel + (anzahl ? ' (' + anzahl + ' Aufzug' + (anzahl === 1 ? '' : 'e') + ')' : ''),
        note: noteLines.join('\n'),
      });
      return jsonResp({ ok: true, pipedrive: pd }, 200, corsHeaders);
    }

    if (body.action === 'soft_capture') {
      const lead = body.lead || {};
      const ct = String(body.check_type || '').trim() || 'unbekannt';
      const fileMeta = body.file_meta || {};
      const name = ((String(lead.vorname || '').trim() + ' ' + String(lead.nachname || '').trim()).trim()) || 'Anonym';
      const email = String(lead.email || '').trim();
      const telefon = String(lead.telefon || '').trim();
      const adresse = String(lead.adresse || '').trim();
      const rolle = String(lead.rolle || '').trim();
      const firma = String(lead.firma || '').trim();
      if (!email) return jsonResp({ ok: false, error: 'email Pflicht' }, 400, corsHeaders);

      const noteLines = [
        '🟡 SOFT-LEAD — User hat Step 2 abgeschickt, Analyse läuft / könnte abbrechen',
        '',
        'Quelle: Vorabcheck Public-Landing',
        'Check-Typ: ' + ct,
        rolle ? 'Rolle: ' + rolle : '',
        adresse ? 'Adresse Objekt: ' + adresse : '',
        firma ? 'Firma: ' + firma : '',
        'Telefon: ' + (telefon || '–'),
        fileMeta.name ? 'Hochgeladenes Dokument: ' + fileMeta.name : '',
        fileMeta.size ? 'Dateigröße: ' + Math.round(fileMeta.size / 1024) + ' KB' : '',
      ].filter(Boolean);

      const pd = await upsertPipedriveLead({
        name,
        email,
        phone: telefon || undefined,
        org: firma || undefined,
        title: '[Vorabcheck Start] ' + name + ' — ' + ct,
        note: noteLines.join('\n'),
      });
      return jsonResp({ ok: true, pipedrive: pd }, 200, corsHeaders);
    }

    if (body.action === 'request_liftaro_callback') {
      const c = body.cta || {};
      const userEmail = String(c.user_email || '').trim();
      const userName  = String(c.user_name  || '').trim() || userEmail || 'Anonym';
      const checkNr   = String(c.check_nr   || '').trim() || '—';
      const role      = String(c.role       || 'eigentuemer').trim();
      const savings   = Number(c.savings_total_eur || 0);
      const hvName    = String(c.hv_name    || '').trim();
      if (!userEmail) return jsonResp({ ok: false, error: 'user_email Pflichtfeld' }, 400, corsHeaders);

      const fmt = (n: number) => Math.round(n).toLocaleString('de-DE');
      const roleLabel = role === 'eigentuemer' ? 'Eigentümer'
                      : role === 'verwalter'  ? 'Hausverwalter'
                      :                          'Mieter';
      const noteLines = [
        '🔥 HOT-LEAD — User hat „Direktkontakt durch Liftaro" angeklickt',
        '',
        'User-Wunsch: Liftaro soll proaktiv binnen 24h kontaktieren.',
        '',
        'Vorabcheck-Kontext:',
        '  Check-Nr: ' + checkNr,
        '  Rolle: ' + roleLabel,
        savings ? '  Sparpotenzial: ' + fmt(savings) + ' € / Jahr' : '',
        hvName  ? '  Hausverwaltung (genannt): ' + hvName : '  Hausverwaltung: nicht angegeben',
        '',
        'Empfehlung Vertrieb:',
        '  → Anruf oder persönliche Mail innerhalb 24h.',
        '  → Konkrete Einsparungsberechnung anbieten.',
        '  → Light-Paket-Pitch anschließen wenn passend.',
      ].filter(Boolean);

      const result = await upsertPipedriveLead({
        name: userName,
        email: userEmail,
        title: '🔥 [HOT] ' + userName + ' — wünscht Direktkontakt (' + checkNr + ')',
        note: noteLines.join('\n'),
      });
      return jsonResp({ ok: true, pipedrive: result }, 200, corsHeaders);
    }

    if (body.action === 'list_property_managers') {
      const cfg = await loadPipedriveConfig();
      if (!cfg) return jsonResp({ ok: false, error: 'pipedrive not configured' }, 500, corsHeaders);
      const lim = Math.min(parseInt(String(body.limit || '500'), 10) || 500, 500);
      try {
        const r = await fetch('https://' + cfg.domain + '/api/v1/organizations?start=0&limit=' + lim +
          '&api_token=' + encodeURIComponent(cfg.token));
        const d = await r.json();
        const orgs = (Array.isArray(d.data) ? d.data : []).map((o: any) => ({
          org_id: o.id, name: o.name || '', address: o.address || '',
          person_count: Number(o.people_count || 0),
        }));
        return jsonResp({ ok: true, results: orgs }, 200, corsHeaders);
      } catch (e: any) { return jsonResp({ ok: false, error: e.message }, 500, corsHeaders); }
    }
    if (body.action === 'get_property_manager_details') {
      const oid = parseInt(String(body.org_id || '0'), 10);
      if (!oid) return jsonResp({ ok: false, error: 'org_id required' }, 400, corsHeaders);
      const cfg = await loadPipedriveConfig();
      if (!cfg) return jsonResp({ ok: false, error: 'pipedrive not configured' }, 500, corsHeaders);
      const auth = '?api_token=' + encodeURIComponent(cfg.token);
      try {
        const oRes = await fetch('https://' + cfg.domain + '/api/v1/organizations/' + oid + auth);
        const oData = await oRes.json();
        if (!oData?.success) return jsonResp({ ok: false, error: 'org not found' }, 404, corsHeaders);
        const org = oData.data;
        const pRes = await fetch('https://' + cfg.domain + '/api/v1/organizations/' + oid + '/persons' + auth);
        const pData = await pRes.json();
        const persons = Array.isArray(pData?.data) ? pData.data : [];
        const genEmail = pickGenericEmailFromPersons(persons);
        let gfName = '', gfTel = '', gfEmail = '';
        const personalP = persons.find((p: any) => {
          const emails = Array.isArray(p?.email) ? p.email : [];
          return emails.some((e: any) => e?.value && !isGenericHvEmail(String(e.value)));
        });
        const firstP = personalP || persons[0];
        if (firstP) {
          gfName = String(firstP.name || '').replace(/\s*\(Allgemein\)\s*$/i, '').trim();
          gfEmail = String((Array.isArray(firstP.email) ? firstP.email : []).find((e: any) => e?.value)?.value || '');
          gfTel = String((Array.isArray(firstP.phone) ? firstP.phone : []).find((p: any) => p?.value)?.value || '');
        }
        let strasse = '', plz = '', ort = '';
        const addr = String(org.address || '').trim();
        if (addr) {
          const parts = addr.split(',').map((s: string) => s.trim()).filter(Boolean);
          if (parts.length >= 2) {
            strasse = parts[0];
            const m = parts[1].match(/^(\d{4,5})\s+(.+)$/);
            if (m) { plz = m[1]; ort = m[2]; } else ort = parts[1];
          } else { strasse = addr; }
        }
        return jsonResp({ ok: true, details: {
          org_id: org.id, firma: String(org.name || ''), gf: gfName,
          strasse, plz, ort, email: genEmail || gfEmail || '', tel: gfTel,
        } }, 200, corsHeaders);
      } catch (e: any) { return jsonResp({ ok: false, error: e.message }, 500, corsHeaders); }
    }
    // Verwalter-Landing: Kontext laden (Eigentuemer-Name, Objekt, Sparpotenzial)
    if (body.action === 'get_verwalter_context') {
      const cn = String(body.check_nr || '').trim();
      if (!cn) return jsonResp({ ok: false, error: 'check_nr missing' }, 400, corsHeaders);
      const k = Deno.env.get("AIRTABLE_KEY"); const b = Deno.env.get("AIRTABLE_BASE_ID");
      if (!k || !b) return jsonResp({ ok: false, error: 'airtable nicht konfiguriert' }, 500, corsHeaders);
      try {
        const enc = encodeURIComponent("{check_nr}='" + cn + "'");
        const [vr, lr] = await Promise.all([
          fetch('https://api.airtable.com/v0/' + b + '/Vorab-Checks?filterByFormula=' + enc + '&maxRecords=1',
            { headers: { Authorization: 'Bearer ' + k } }),
          fetch('https://api.airtable.com/v0/' + b + '/Vorabcheck-Leads?filterByFormula=' + enc + '&maxRecords=1',
            { headers: { Authorization: 'Bearer ' + k } }),
        ]);
        const vd = await vr.json(); const ld = await lr.json();
        const vc = vd?.records?.[0]?.fields;
        if (!vc) return jsonResp({ ok: false, error: 'check not found' }, 404, corsHeaders);
        const lead = ld?.records?.[0]?.fields || {};
        return jsonResp({ ok: true, ctx: {
          check_nr: cn,
          check_type: vc.check_type || '',
          ampel: vc.ampel || '',
          summary: vc.summary || '',
          savings_total_eur: Number(vc.savings_total_eur || vc.savings_estimate_eur || 0),
          savings_individual_eur: Number(vc.savings_individual_eur || 0),
          aufzug_count: Number(vc.aufzug_count || 0),
          parteien_count: Number(vc.parteien_count || 0),
          role: vc.role || '',
          eigentuemer_name: [lead.vorname, lead.nachname].filter(Boolean).join(' '),
          // Objekt-Adresse: KI-extrahiert > Step-4-bestätigt > Lead-Adresse (Reihenfolge umgedreht zu V9.85)
          objekt_adresse: String(vc.objekt_adresse || lead.adresse || ''),
          // HV-Daten aus Eigentümer-CTA → die Verwalter-Landing füllt sie vor, HV bestätigt nur
          hv_name:    vc.hv_name    || '',
          hv_email:   vc.hv_email   || '',
          hv_telefon: vc.hv_telefon || '',
          hv_adresse: vc.hv_adresse || '',
          hv_website: vc.hv_website || '',
          verwalter_status: vc.verwalter_status || 'offen',
          verwalter_name: vc.verwalter_name || '',
          verwalter_response_at: vc.verwalter_response_at || '',
        } }, 200, corsHeaders);
      } catch (e: any) { return jsonResp({ ok: false, error: e.message }, 500, corsHeaders); }
    }
    if (body.action === 'submit_verwalter_response') {
      const cn = String(body.check_nr || '').trim();
      const v = body.verwalter || {};
      const mode = String(body.mode || '').trim();
      if (!cn) return jsonResp({ ok: false, error: 'check_nr missing' }, 400, corsHeaders);
      if (!v.name || !v.email) return jsonResp({ ok: false, error: 'name+email pflicht' }, 400, corsHeaders);
      const k = Deno.env.get("AIRTABLE_KEY"); const b = Deno.env.get("AIRTABLE_BASE_ID");
      if (!k || !b) return jsonResp({ ok: false, error: 'airtable nicht konfiguriert' }, 500, corsHeaders);
      try {
        const fr = await fetch('https://api.airtable.com/v0/' + b + "/Vorab-Checks?filterByFormula=" + encodeURIComponent("{check_nr}='" + cn + "'") + '&maxRecords=1', { headers: { Authorization: 'Bearer ' + k } });
        const recId = (await fr.json())?.records?.[0]?.id;
        if (!recId) return jsonResp({ ok: false, error: 'check not found' }, 404, corsHeaders);
        const fields: any = {
          verwalter_name: String(v.name || '').trim(),
          verwalter_email: String(v.email || '').trim(),
          verwalter_telefon: String(v.telefon || '').trim(),
          verwalter_response_mode: mode,
          verwalter_response_at: new Date().toISOString(),
          verwalter_status: 'antwort_erhalten',
        };
        // HV-Firma (neu in V9.86): kommt aus der Verwalter-Landing wenn keine hv_name aus Eigentümer-CTA da war
        const vFirma = String(v.firma || '').trim();
        if (vFirma) fields.verwalter_firma_name = vFirma;
        // HV bestätigt/korrigiert Objekt-Adresse: in eigenes Feld + auch objekt_adresse aktualisieren
        const vObj = String(v.objekt_adresse || '').trim();
        if (vObj) { fields.verwalter_objekt_adresse = vObj; fields.objekt_adresse = vObj; }
        if (body.responses) fields.verwalter_response_json = JSON.stringify(body.responses);
        if (mode === 'fragen' && body.responses && typeof body.responses === 'object') {
          const r: any = body.responses;
          if (r.anzahl_aufzuege) {
            const n = parseInt(String(r.anzahl_aufzuege), 10);
            if (n > 0 && n <= 50) fields.vertrag_anzahl_aufzuege = n;
          }
          if (r.wartungen)   fields.vertrag_wartungen_pro_jahr = String(r.wartungen);
          if (r.vertragsart === 'voll')   fields.vertrag_wartungstyp = 'Vollwartung';
          if (r.vertragsart === 'system') fields.vertrag_wartungstyp = 'Systemwartung';
          if (r.tuev_begl)  fields.vertrag_tuev_begleitung = (r.tuev_begl === 'inkl');
          if (r.tuev_pruef) fields.vertrag_tuev_pruefung   = (r.tuev_pruef === 'inkl');
          if (r.notruf)     fields.vertrag_notruf          = (r.notruf === 'inkl');
          fields.vertrag_extracted_at     = new Date().toISOString();
          fields.vertrag_extracted_source = 'konfig';
        }
        if (body.pdf_base64 && body.pdf_base64.length > 100) {
          // PDF nur als Attachment speichern — KI-Analyse läuft später im Vertragscheck-Frontend
          // über die bereits existierende handleFile()→extractFromPDF()-Pipeline.
          const fname = String(body.pdf_name || 'vertrag.pdf');
          try {
            const up = await fetch('https://content.airtable.com/v0/' + b + '/' + recId + '/verwalter_response_pdf/uploadAttachment', {
              method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
              body: JSON.stringify({ contentType: String(body.pdf_mime || 'application/pdf'), filename: fname, file: body.pdf_base64 }),
            });
            if (!up.ok) fields.verwalter_response_pdf_name = fname + ' (Upload fehlgeschlagen)';
          } catch (e) { fields.verwalter_response_pdf_name = fname; }
        }
        await atPatchRetry('https://api.airtable.com/v0/' + b + '/Vorab-Checks/' + recId, k, fields, 25);
        return jsonResp({ ok: true, applied_fields: Object.keys(fields) }, 200, corsHeaders);
      } catch (e: any) { return jsonResp({ ok: false, error: e.message }, 500, corsHeaders); }
    }
    // Bearbeiter-Inbox: Status setzen (offen / in_bearbeitung / erledigt)
    if (body.action === 'set_bearbeiter_status') {
      const cn = String(body.check_nr || '').trim();
      const st = String(body.status || '').trim();
      const allowed = new Set(['offen', 'in_bearbeitung', 'erledigt']);
      if (!cn) return jsonResp({ ok: false, error: 'check_nr missing' }, 400, corsHeaders);
      if (!allowed.has(st)) return jsonResp({ ok: false, error: 'status invalid' }, 400, corsHeaders);
      const k = Deno.env.get("AIRTABLE_KEY"); const b = Deno.env.get("AIRTABLE_BASE_ID");
      if (!k || !b) return jsonResp({ ok: false, error: 'airtable nicht konfiguriert' }, 500, corsHeaders);
      try {
        const fr = await fetch('https://api.airtable.com/v0/' + b + "/Vorab-Checks?filterByFormula=" + encodeURIComponent("{check_nr}='" + cn + "'") + '&maxRecords=1', { headers: { Authorization: 'Bearer ' + k } });
        const recId = (await fr.json())?.records?.[0]?.id;
        if (!recId) return jsonResp({ ok: false, error: 'check not found' }, 404, corsHeaders);
        // Felder mit Retry-on-Unknown-Field (analog atPostSafe in saveToAirtable)
        const fields: any = {
          bearbeiter_status: st,
          bearbeiter_status_at: new Date().toISOString(),
        };
        if (body.bearbeiter_name) fields.bearbeiter_name = String(body.bearbeiter_name).trim();
        const res = await atPatchRetry('https://api.airtable.com/v0/' + b + '/Vorab-Checks/' + recId, k, fields, 10);
        return res.ok ? jsonResp({ ok: true, status: st }, 200, corsHeaders) : jsonResp({ ok: false, error: res.error }, 500, corsHeaders);
      } catch (e: any) { return jsonResp({ ok: false, error: e.message }, 500, corsHeaders); }
    }
    // Folge-Check (z.B. Vertragscheck) mit Vorabcheck verknüpfen
    if (body.action === 'link_followup_check') {
      const cn = String(body.check_nr || '').trim();
      if (!cn) return jsonResp({ ok: false, error: 'check_nr missing' }, 400, corsHeaders);
      const k = Deno.env.get("AIRTABLE_KEY"); const b = Deno.env.get("AIRTABLE_BASE_ID");
      if (!k || !b) return jsonResp({ ok: false, error: 'airtable nicht konfiguriert' }, 500, corsHeaders);
      try {
        const fr = await fetch('https://api.airtable.com/v0/' + b + "/Vorab-Checks?filterByFormula=" + encodeURIComponent("{check_nr}='" + cn + "'") + '&maxRecords=1', { headers: { Authorization: 'Bearer ' + k } });
        const recId = (await fr.json())?.records?.[0]?.id;
        if (!recId) return jsonResp({ ok: false, error: 'check not found' }, 404, corsHeaders);
        const fields: any = {
          linked_check_id:         String(body.linked_check_id || '').trim(),
          linked_check_requestid:  String(body.linked_check_requestid || '').trim(),
          linked_check_type:       String(body.linked_check_type || '').trim(),
          linked_check_ersparnis:  String(body.linked_check_ersparnis || '').trim(),
          linked_check_at:         new Date().toISOString(),
          bearbeiter_status:       'in_bearbeitung',
          bearbeiter_status_at:    new Date().toISOString(),
        };
        const res = await atPatchRetry('https://api.airtable.com/v0/' + b + '/Vorab-Checks/' + recId, k, fields, 15);
        return res.ok ? jsonResp({ ok: true, linked: fields.linked_check_requestid }, 200, corsHeaders) : jsonResp({ ok: false, error: res.error }, 500, corsHeaders);
      } catch (e: any) { return jsonResp({ ok: false, error: e.message }, 500, corsHeaders); }
    }
    // Objekt-Adresse nachträglich am Vorab-Check-Record patchen (Step-4-Bestätigung der Public-Landing)
    if (body.action === 'patch_objekt_adresse') {
      const cn = String(body.check_nr || '').trim();
      const addr = String(body.objekt_adresse || '').trim();
      if (!cn || !addr) return jsonResp({ ok: false, error: 'check_nr + objekt_adresse erforderlich' }, 400, corsHeaders);
      const k = Deno.env.get("AIRTABLE_KEY"); const b = Deno.env.get("AIRTABLE_BASE_ID");
      if (!k || !b) return jsonResp({ ok: false, error: 'airtable nicht konfiguriert' }, 500, corsHeaders);
      try {
        const fr = await fetch('https://api.airtable.com/v0/' + b + "/Vorab-Checks?filterByFormula=" + encodeURIComponent("{check_nr}='" + cn + "'") + '&maxRecords=1', { headers: { Authorization: 'Bearer ' + k } });
        const recId = (await fr.json())?.records?.[0]?.id;
        if (!recId) return jsonResp({ ok: false, error: 'check not found' }, 404, corsHeaders);
        const res = await atPatchRetry('https://api.airtable.com/v0/' + b + '/Vorab-Checks/' + recId, k, { objekt_adresse: addr });
        return res.ok ? jsonResp({ ok: true }, 200, corsHeaders) : jsonResp({ ok: false, error: res.error }, 500, corsHeaders);
      } catch (e: any) { return jsonResp({ ok: false, error: e.message }, 500, corsHeaders); }
    }
    if (body.action === 'enrich_property_manager') {
      const name = String(body.name || '').trim();
      const city = String(body.city || '').trim();
      if (!name) return jsonResp({ ok: false, error: 'name required' }, 400, corsHeaders);
      // Erst Env-Var (schnell, kein Airtable-Roundtrip), dann Master-Base als Fallback
      let serperKey = String(Deno.env.get("SERPER_API_KEY") || '').trim();
      if (!serperKey) {
        const atKey = Deno.env.get("AIRTABLE_KEY");
        try {
          const url = 'https://api.airtable.com/v0/' + PIPEDRIVE_MASTER_BASE + '/Keys?filterByFormula=' +
            encodeURIComponent("AND({project_id}='" + PIPEDRIVE_PROJECT_ID + "',{key_name}='serperApiKey')");
          const r = await fetch(url, { headers: { Authorization: 'Bearer ' + atKey } });
          const d = await r.json();
          serperKey = String(d?.records?.[0]?.fields?.key_value || '').trim();
        } catch (e) { /* */ }
      }
      if (!serperKey) return jsonResp({ ok: false, error: 'SERPER_API_KEY nicht konfiguriert (Env-Var oder Master-Base)' }, 500, corsHeaders);
      const q = '"' + name + '"' + (city ? ' ' + city : '') + ' Hausverwaltung Impressum';
      let snippets = '';
      try {
        const sr = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, gl: 'de', hl: 'de', num: 5 }),
        });
        const sd = await sr.json();
        const hits = Array.isArray(sd.organic) ? sd.organic.slice(0, 3) : [];
        snippets = hits.map((h: any) => 'URL: ' + (h.link || '') + '\nTitel: ' + (h.title || '') + '\nSnippet: ' + (h.snippet || '')).join('\n\n');
      } catch (e: any) { return jsonResp({ ok: false, error: 'Serper: ' + e.message }, 500, corsHeaders); }
      if (!snippets) return jsonResp({ ok: false, error: 'Keine Suchergebnisse' }, 404, corsHeaders);
      const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_KEY") });
      const sys = 'Du extrahierst Stammdaten von Hausverwaltungen aus Google-Suchergebnis-Snippets. WICHTIG: Gib NUR Werte zurueck, die WORTWOERTLICH in den Snippets vorkommen. Wenn ein Feld nicht eindeutig im Text steht, setze es auf null. Erfinde NICHTS. Antworte ausschliesslich als JSON ohne Fliesstext und ohne Markdown-Code-Block.';
      const userPrompt = 'Hausverwaltung: "' + name + '"' + (city ? ' in ' + city : '') + '\n\nExtrahiere die offiziellen Stammdaten.\n\nFormat:\n{\n  "strasse": "...",\n  "plz": "...",\n  "ort": "...",\n  "telefon": "...",\n  "email": "...",\n  "ustidnr": "DEXXXXXXXXX",\n  "steuernr": "...",\n  "website": "..."\n}\n\nSuchergebnisse:\n' + snippets;
      try {
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 600,
          system: sys,
          messages: [{ role: 'user', content: userPrompt }],
        });
        const txt = (msg.content[0] as any)?.type === 'text' ? (msg.content[0] as any).text : '';
        const jm = txt.match(/\{[\s\S]*\}/);
        if (!jm) return jsonResp({ ok: false, error: 'KI hat keine Daten geliefert' }, 200, corsHeaders);
        const raw = JSON.parse(jm[0]);
        const snipLow = snippets.toLowerCase();
        const snipNoSpace = snipLow.replace(/\s+/g, '');
        const data: any = {};
        for (const k of ['strasse','plz','ort','telefon','email','ustidnr','steuernr','website']) {
          const v = raw[k];
          if (v && typeof v === 'string' && v !== 'null' && v.trim().length > 1) {
            const vLow = String(v).toLowerCase();
            const vNoSpace = vLow.replace(/\s+/g, '');
            if (snipLow.includes(vLow) || snipNoSpace.includes(vNoSpace)) {
              data[k] = String(v).trim();
            }
          }
        }
        return jsonResp({ ok: true, data, snippet_count: snippets.split('\n\n').length }, 200, corsHeaders);
      } catch (e: any) { return jsonResp({ ok: false, error: 'Claude: ' + e.message }, 500, corsHeaders); }
    }
    if (body.action === 'find_property_manager') {
      const q = String(body.query || '').trim();
      if (q.length < 3) return jsonResp({ ok: true, results: [] }, 200, corsHeaders);
      const orgs = await findPipedriveOrgsByName(q, 3);
      if (!orgs.length) return jsonResp({ ok: true, results: [], source: 'db' }, 200, corsHeaders);
      const enriched = await Promise.all(orgs.map(async (org: any) => {
        const email = await getOrgGenericEmail(org.id);
        return {
          org_id: org.id,
          name: org.name,
          email: email,                 // null wenn nur personalisierte Mails vorhanden
          city: org.address || '',      // best-effort, Pipedrive-Adresse als Volltext
          confidence: email ? 100 : 60, // mit Email = sichere DB-Quelle
        };
      }));
      return jsonResp({ ok: true, source: 'db', results: enriched }, 200, corsHeaders);
    }

    if (body.action === 'submit_eigentuemer_cta') {
      const c = body.cta || {};
      const hvName    = String(c.hv_name  || '').trim();
      const hvEmail   = String(c.hv_email || '').trim();
      const hvAddress = String(c.hv_address || '').trim();
      const hvTelefon = String(c.hv_telefon || '').trim();
      const hvWebsite = String(c.hv_website || '').trim();
      const userEmail = String(c.user_email || '').trim();
      const userName  = String(c.user_name  || '').trim() || userEmail || 'Anonym';
      const checkNr   = String(c.check_nr || '').trim() || '—';
      const role      = String(c.role     || 'eigentuemer').trim();
      const savings   = Number(c.savings_total_eur || 0);

      if (!hvName) return jsonResp({ ok: false, error: 'hv_name Pflichtfeld' }, 400, corsHeaders);

      try {
        let org = await findPipedriveOrgByName(hvName);
        let orgId: number | null = org?.id || null;
        let orgCreated = false;
        if (!orgId) {
          // Bei neuer Org: Web-Adresse als Pipedrive-Address-Feld nutzen, Source 'ki_web' wenn aus Web-Suche
          const created = await createPipedriveOrgWithEmail({
            name: hvName,
            email: isGenericHvEmail(hvEmail) ? hvEmail : undefined,
            city: hvAddress || undefined,
            source: hvAddress ? 'ki_web' : 'user_verifiziert',
          });
          if (created.ok && created.org_id) {
            orgId = created.org_id;
            orgCreated = true;
            // Telefon + Website als Note an die neue Org haengen (Pipedrive-Org-Update fuer custom fields umstaendlich)
            if (hvTelefon || hvWebsite) {
              const cfgN = await loadPipedriveConfig();
              if (cfgN) {
                const noteContent = '🔍 Aus Web-Suche extrahiert:\n' +
                  (hvAddress ? 'Adresse: ' + hvAddress + '\n' : '') +
                  (hvTelefon ? 'Telefon: ' + hvTelefon + '\n' : '') +
                  (hvWebsite ? 'Website: ' + hvWebsite + '\n' : '');
                await fetch('https://' + cfgN.domain + '/api/v1/notes?api_token=' + encodeURIComponent(cfgN.token), {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content: noteContent, org_id: orgId }),
                }).catch(() => { /* non-critical */ });
              }
            }
          }
        }

        if (orgId && !orgCreated && hvEmail && isGenericHvEmail(hvEmail)) {
          const existingMail = await getOrgGenericEmail(orgId);
          if (!existingMail) {
            const cfg = await loadPipedriveConfig();
            if (cfg) {
              const auth = '?api_token=' + encodeURIComponent(cfg.token);
              await fetch('https://' + cfg.domain + '/api/v1/persons' + auth, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: hvName + ' (Allgemein)',
                  email: [{ value: hvEmail, primary: true, label: 'work' }],
                  org_id: orgId,
                }),
              }).catch(() => {  });
            }
          }
        }

        let userPersonId: number | null = null;
        if (orgId && userEmail) {
          const cfg = await loadPipedriveConfig();
          if (cfg) {
            try {
              const searchUrl = 'https://' + cfg.domain + '/api/v1/persons/search?fields=email&exact_match=true&limit=5&term=' +
                encodeURIComponent(userEmail) + '&api_token=' + encodeURIComponent(cfg.token);
              const sr = await fetch(searchUrl);
              const sd = await sr.json();
              if (sd?.success && sd.data?.items?.length) {
                userPersonId = sd.data.items[0].item?.id || null;
              }
            } catch (e) {  }
          }
          if (userPersonId) await linkPersonToOrg(userPersonId, orgId);
        }

        let hvLead: any = { ok: false };
        if (orgId) {
          hvLead = await createHvLead({
            orgId,
            userFullName: userName,
            userEmail,
            savingsTotal: savings,
            checkNr,
            role,
            hvName,
          });
        }

        // HV-Daten zusaetzlich in Vorab-Checks-Row patchen (damit alles an EINER Stelle steht)
        try {
          const ak = Deno.env.get("AIRTABLE_KEY"); const ab = Deno.env.get("AIRTABLE_BASE_ID");
          if (ak && ab && checkNr && checkNr !== '—') {
            const fr = await fetch('https://api.airtable.com/v0/' + ab + "/Vorab-Checks?filterByFormula=" + encodeURIComponent("{check_nr}='" + checkNr + "'") + '&maxRecords=1', { headers: { Authorization: 'Bearer ' + ak } });
            const rId = (await fr.json())?.records?.[0]?.id;
            if (rId) {
              const hvFields: any = {};
              if (hvName)    hvFields.hv_name    = hvName;
              if (hvEmail)   hvFields.hv_email   = hvEmail;
              if (hvTelefon) hvFields.hv_telefon = hvTelefon;
              if (hvAddress) hvFields.hv_adresse = hvAddress;
              if (hvWebsite) hvFields.hv_website = hvWebsite;
              if (orgId)     hvFields.hv_pipedrive_org_id = String(orgId);
              if (Object.keys(hvFields).length) {
                // PATCH mit Retry-on-Unknown-Field
                let fields: any = { ...hvFields };
                for (let i = 0; i < 12; i++) {
                  const pr = await fetch('https://api.airtable.com/v0/' + ab + '/Vorab-Checks/' + rId, {
                    method: 'PATCH',
                    headers: { Authorization: 'Bearer ' + ak, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields }),
                  });
                  if (pr.ok) break;
                  const txt = await pr.text();
                  let bad = '';
                  try { const j = JSON.parse(txt); const msg = j?.error?.message || ''; const m = String(msg).match(/Unknown field name:\s*"([^"]+)"/i); if (m) bad = m[1]; } catch (_) {}
                  if (bad && Object.prototype.hasOwnProperty.call(fields, bad)) { delete fields[bad]; continue; }
                  break;
                }
              }
            }
          }
        } catch (e) { /* HV-Patch non-critical */ }
        return jsonResp({
          ok: true,
          org_id: orgId,
          org_created: orgCreated,
          user_person_id: userPersonId,
          hv_lead: hvLead,
        }, 200, corsHeaders);
      } catch (e: any) {
        return jsonResp({ ok: false, error: 'Exception: ' + (e.message || String(e)) }, 500, corsHeaders);
      }
    }

    if (body.action === 'get_defaults') {
      return jsonResp({
        prompts: DEFAULT_SYSTEM_PROMPTS,
        role_contexts: ROLE_CONTEXTS,
        model: MODEL,
        backend_version: 'V9.87',
        backend_features: ['set_bearbeiter_status', 'link_followup_check', 'vertrag_mapping_konfig', 'patch_retry_on_unknown_field', 'ensure_vorabcheck_schema', 'verwalter_pdf_attachment'],
      }, 200, corsHeaders);
    }
    if (body.action === 'ensure_vorabcheck_schema') {
      const k = Deno.env.get("AIRTABLE_KEY"); const b = Deno.env.get("AIRTABLE_BASE_ID");
      if (!k || !b) return jsonResp({ ok: false, error: 'airtable nicht konfiguriert' }, 500, corsHeaders);
      const TARGET_FIELDS: any[] = VORABCHECK_TARGET_FIELDS;
      try {
        // Schema lesen
        const schemaRes = await fetch('https://api.airtable.com/v0/meta/bases/' + b + '/tables', {
          headers: { Authorization: 'Bearer ' + k },
        });
        if (!schemaRes.ok) {
          const txt = await schemaRes.text();
          let hint = '';
          if (schemaRes.status === 403 || schemaRes.status === 401) {
            hint = ' — Dein Airtable-PAT braucht den Scope schema.bases:read und schema.bases:write. Erweitere ihn unter airtable.com/create/tokens.';
          }
          return jsonResp({ ok: false, error: 'Schema lesen fehlgeschlagen (HTTP ' + schemaRes.status + ')' + hint, raw: txt.slice(0, 300) }, schemaRes.status, corsHeaders);
        }
        const schema = await schemaRes.json();
        const tbl = schema.tables?.find((t: any) => t.name === 'Vorab-Checks');
        if (!tbl) return jsonResp({ ok: false, error: 'Tabelle „Vorab-Checks" nicht gefunden' }, 404, corsHeaders);
        const existingNames = new Set(tbl.fields.map((f: any) => f.name));
        const created: string[] = [];
        const skipped: string[] = [];
        const failed: any[] = [];
        if (body.dry_run) {
          for (const field of TARGET_FIELDS) {
            if (existingNames.has(field.name)) skipped.push(field.name);
            else created.push(field.name);
          }
          return jsonResp({ ok: true, dry_run: true, would_create: created, already_exists: skipped, total_target: TARGET_FIELDS.length, table_id: tbl.id }, 200, corsHeaders);
        }
        // Felder einzeln anlegen
        for (const field of TARGET_FIELDS) {
          if (existingNames.has(field.name)) { skipped.push(field.name); continue; }
          const createRes = await fetch('https://api.airtable.com/v0/meta/bases/' + b + '/tables/' + tbl.id + '/fields', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
            body: JSON.stringify(field),
          });
          if (createRes.ok) {
            created.push(field.name);
          } else {
            const txt = await createRes.text();
            failed.push({ name: field.name, status: createRes.status, error: txt.slice(0, 200) });
          }
        }
        return jsonResp({ ok: true, created, skipped, failed, total_target: TARGET_FIELDS.length, table_id: tbl.id }, 200, corsHeaders);
      } catch (e: any) {
        return jsonResp({ ok: false, error: e.message }, 500, corsHeaders);
      }
    }
    // Schneller Health-/Version-Check ohne Side-Effects
    if (body.action === 'ping') {
      return jsonResp({
        ok: true,
        backend_version: 'V9.87',
        backend_features: ['set_bearbeiter_status', 'link_followup_check', 'vertrag_mapping_konfig', 'patch_retry_on_unknown_field', 'ensure_vorabcheck_schema', 'verwalter_pdf_attachment'],
        model: MODEL,
      }, 200, corsHeaders);
    }

    if (body.action === 'correct') {
      const cn = String(body.check_nr || '').trim();
      if (!cn) return jsonResp({ error: 'check_nr fehlt' }, 400, corsHeaders);
      const key = Deno.env.get("AIRTABLE_KEY");
      const base = Deno.env.get("AIRTABLE_BASE_ID");
      if (!key || !base) return jsonResp({ ok: false, warning: 'Airtable nicht konfiguriert' }, 200, corsHeaders);
      const fields = body.fields || {};
      const records: any[] = [];
      Object.keys(fields).forEach(k => {
        const v = fields[k];
        if (v && v.changed) {
          records.push({
            fields: {
              check_nr: cn,
              field_name: k,
              original_value: String(v.original ?? ''),
              corrected_value: String(v.corrected ?? ''),
              savedAt: new Date().toISOString(),
            }
          });
        }
      });
      if (!records.length) return jsonResp({ ok: true, count: 0 }, 200, corsHeaders);
      try {
        const url = `https://api.airtable.com/v0/${base}/Vorabcheck-Korrekturen`;
        for (let i = 0; i < records.length; i += 10) {
          const batch = records.slice(i, i + 10);
          await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: batch }),
          });
        }
        return jsonResp({ ok: true, count: records.length }, 200, corsHeaders);
      } catch (e: any) {
        return jsonResp({ ok: false, error: e.message }, 500, corsHeaders);
      }
    }

    const { check_type, file, lead, turnstile_token, consent_given } = body;
    const role = ['mieter','eigentuemer','verwalter'].includes(body.role) ? body.role : 'mieter';
    const aufzugCountUser = Math.max(1, Math.min(50, parseInt(String(body.aufzug_count_user || '1'), 10) || 1));
    const wartungBruttoUser = Math.max(0, parseFloat(String(body.wartung_brutto_user || '0').replace(',', '.')) || 0);

    const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
    // Dev-Bypass-Token: Frontend kann mit ?dev=1 testen ohne Turnstile-Validierung (echte User nutzen es nicht)
    const isDevBypass = String(turnstile_token || '') === 'dev-bypass-token';
    if (turnstileSecret && turnstile_token && !isDevBypass) {
      const ok = await verifyTurnstile(turnstile_token, turnstileSecret);
      if (!ok) return jsonResp({ error: "Captcha ungültig" }, 403, corsHeaders);
    }

    if (!consent_given) return jsonResp({ error: "Einwilligung fehlt" }, 400, corsHeaders);

    const custom = await loadCustomPrompts();
    let systemPrompt = buildSystemPrompt(check_type, role, custom);
    if (!systemPrompt) return jsonResp({ error: "Unbekannter Check-Typ" }, 400, corsHeaders);

    let preisrefList: any[] = [];
    if (check_type === 'angebot') {
      preisrefList = await loadPreisreferenzen();
      if (preisrefList.length) {
        const preisrefBlock =
          '\n\n═══════════════════════════════════════════\n' +
          'MARKTPREIS-REFERENZEN (verbindlich, NICHT VERHANDELBAR)\n' +
          '═══════════════════════════════════════════\n' +
          'Diese Liste enthält den aktuellen Marktmedian je Position für Aufzug-Reparatur/Wartung. ' +
          'Vergleiche JEDE Angebots-Position mit dieser Liste:\n\n' +
          preisrefList.map((p, i) =>
            (i + 1) + '. ' + p.position + ' — ' + p.median_eur.toFixed(2) + ' € pro ' + p.einheit +
            (p.region ? ' (' + p.region + ')' : '') +
            (p.notes ? ' — ' + p.notes : '')
          ).join('\n') + '\n\n' +
          'Wenn eine Angebots-Position in dieser Liste auftaucht: nutze den Median als Vergleichsbasis. ' +
          'Die konkreten Median-€-Werte dürfen in deiner Antwort genannt werden, denn sie sind Liftaro-Marktdaten. ' +
          'Wenn eine Angebots-Position NICHT in der Liste steht, gib in deiner JSON-Antwort ein Feld ' +
          '"positions_nicht_in_liste": [{titel, betrag_eur}] mit den entsprechenden Positionen zurück — ' +
          'das Backend schätzt dafür einen Fallback-Wert.';
        systemPrompt = systemPrompt + preisrefBlock;
      }
    }

    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_KEY") });
    const t0 = Date.now();

    const isPdf = file.mime === "application/pdf";
    const userContent: any[] = [
      {
        type: isPdf ? "document" : "image",
        source: { type: "base64", media_type: file.mime, data: file.base64 },
      },
      { type: "text", text: "Prüfe das beigefügte Dokument gemäß den Vorgaben und antworte ausschließlich mit dem geforderten JSON. Falls im Dokument eine Objekt-, Liegenschafts- oder Gebäudeadresse erkennbar ist (z.B. 'Beispielstr. 12, 55116 Mainz'), gib sie zusätzlich als Top-Level-Feld 'objekt_adresse' (String, Format: 'Straße Hausnr., PLZ Ort') zurück. Wenn nicht eindeutig erkennbar, setze 'objekt_adresse' auf einen leeren String." },
    ];

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096, // Erhöht von 2048 — komplexe Tabellen brauchen mehr Output-Spielraum
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const duration_ms = Date.now() - t0;
    const tokens_in = response.usage.input_tokens;
    const tokens_out = response.usage.output_tokens;
    const cost_eur = ((tokens_in * COST_PER_M_INPUT_TOKENS + tokens_out * COST_PER_M_OUTPUT_TOKENS) / 1_000_000) * USD_TO_EUR;

    const textBlock = response.content.find((c: any) => c.type === "text");
    const rawText = textBlock?.text || "{}";
    const cleaned = rawText.replace(/^```json\s*|\s*```$/g, "").trim();
    let result: any;
    try { result = JSON.parse(cleaned); }
    catch { return jsonResp({ error: "KI-Antwort konnte nicht geparst werden", raw: rawText }, 500, corsHeaders); }

    const checkNr = await generateCheckNr();
    result.check_nr = checkNr;

    await saveToAirtable({
      check_nr: checkNr,
      check_type,
      role,
      lead,
      result,
      file_name: file.name,
      cost_eur,
      tokens_in,
      tokens_out,
      model: MODEL,
      duration_ms,
    });

    let savingsTotal = Number(result.savings_total_eur || result.savings_estimate_eur || 0);
    const meaPool       = Number(result.mea_pool_total || 0);
    const meaEigentuemer = Number(result.mea_eigentuemer || 0);

    if (check_type === 'nebenkosten') {
      const aufzugCount = aufzugCountUser;
      result.aufzug_count = aufzugCount; // Im Response konsistent halten
      let aufzugBrutto = 0;
      let bruttoSource = 'unknown'; // 'user' | 'ki' | 'regex' — für Transparenz

      if (wartungBruttoUser > 0) {
        aufzugBrutto = wartungBruttoUser;
        bruttoSource = 'user';
        if (!result.anonymized_data) result.anonymized_data = {};
        result.anonymized_data.betrag_aufzug_brutto = aufzugBrutto;
        console.log('[liftaro-vorabcheck] brutto vom User:', aufzugBrutto);
      } else {
        aufzugBrutto = Number(result.anonymized_data?.betrag_aufzug_brutto || 0);
        if (aufzugBrutto >= 500) bruttoSource = 'ki';

        if (!aufzugBrutto || aufzugBrutto < 500) {
          const haystack = String(result.summary || '') + ' ' +
            (result.findings || []).map(f => (f.title||'') + ' ' + (f.description||'')).join(' ');
          const matches = [...haystack.matchAll(/aufzug[a-zäöü\s\-/]*wartung[^0-9]{0,40}(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d{4,6}(?:,\d{2})?)\s*(?:€|eur)/gi)];
          if (matches.length) {
            const candidates = matches.map(m => parseFloat(m[1].replace(/\./g, '').replace(',', '.'))).filter(n => n > 500);
            if (candidates.length) {
              aufzugBrutto = Math.max(...candidates);
              bruttoSource = 'regex';
              console.log('[liftaro-vorabcheck] brutto via Regex aus Klartext:', aufzugBrutto);
            }
          }
        }
      }

      const proAnlage = aufzugCount > 0 ? aufzugBrutto / aufzugCount : 0;

      if (proAnlage > 1200) {
        const correctTotal = Math.round((proAnlage - 980) * aufzugCount);
        const proAnlageStr = Math.round(proAnlage).toLocaleString('de-DE');
        const diffStr      = Math.round(proAnlage - 980).toLocaleString('de-DE');
        const pctSavings = aufzugBrutto > 0 ? Math.round((correctTotal / aufzugBrutto) * 100) : 0;

        savingsTotal = correctTotal;
        result.savings_text = 'rund ' + pctSavings + ' % der bisherigen Wartungskosten durch marktgerechte Neuausschreibung';

        const summaryHasMarketClaim = /markt|median/i.test(String(result.summary || ''));
        const summaryIsConsistent = summaryHasMarketClaim && /über|ueber|deutlich|teuer/i.test(String(result.summary || ''));
        if (!summaryIsConsistent) {
          result.summary = 'Ihre Wartung kostet ' + proAnlageStr + ' € pro Jahr je Aufzug — das ist rund ' + diffStr + ' € mehr als der übliche Marktpreis für Wartung und Notruf. Optimierungspotenzial vorhanden.';
        }
        if (result.summary) {
          result.summary = String(result.summary).replace(/\bvon\s+9\s?80\s*(€|EUR)\b/gi, '').replace(/\(?\b9\s?80\s*(€|EUR)\b\)?/gi, '').replace(/\s{2,}/g, ' ').trim();
        }
        if (result.savings_text) {
          result.savings_text = String(result.savings_text).replace(/\bvon\s+9\s?80\s*(€|EUR)\b/gi, '').replace(/\(?\b9\s?80\s*(€|EUR)\b\)?/gi, '').replace(/\s{2,}/g, ' ').trim();
        }

        let findings = result.findings || [];
        findings = findings.filter(f => !/markt|wartung.*(zu\s+(teuer|hoch)|ueber|über)|optimierung.*?wartung/i.test((f.title||'') + ' ' + (f.description||'')));
        findings.unshift({
          severity: proAnlage > 1800 ? 'warn' : (proAnlage > 1500 ? 'amber' : 'blue'),
          title: 'Wartung teurer als üblich',
          description: 'Die Wartung kostet ' + proAnlageStr + ' € pro Jahr je Aufzug — rund ' + diffStr + ' € mehr als der übliche Marktpreis. Bei einer Neuausschreibung zu marktüblichen Konditionen sparen Sie ' + correctTotal.toLocaleString('de-DE') + ' € pro Jahr.',
          tag: 'Liftaro-Marktreferenz · aktuell ' + proAnlageStr + ' EUR/Jahr',
        });

        result.findings = findings;

        if ((result.ampel === 'gruen' || result.ampel === 'grün') && proAnlage > 1500) {
          result.ampel = 'gelb';
        }

        console.log('[liftaro-vorabcheck] Markt-Override: brutto=' + aufzugBrutto + ', anlagen=' + aufzugCount + ', proAnlage=' + proAnlage + ', diff=' + diffStr + ', ersparnis=' + correctTotal);
      }

      if (role === 'eigentuemer' || role === 'verwalter') {
        const findings = result.findings || [];
        const hasRepairHint = findings.some(f => /reparatur.*(8\.?000|einsparen|liftaro.*pr[üu]f|zus[äa]tzlich)/i.test((f.title||'') + ' ' + (f.description||'')));
        if (!hasRepairHint) {
          findings.push({
            severity: 'blue',
            title: 'Zusätzliches Sparpotenzial bei Reparaturen',
            description: 'Diese Schätzung berücksichtigt nur Wartung und Notruf. Unterjährige Reparaturen sind nicht eingerechnet — gerade dort steckt oft das größte Potenzial. Durch regelmäßige Überprüfung der Reparatur-Rechnungen durch Liftaro lassen sich im Einzelfall bis zu 8.000 € zusätzlich einsparen.',
            tag: 'Reparatur-Prüfung · Liftaro-Service',
          });
          result.findings = findings;
        }
      }
    }

    if (check_type === 'angebot') {
      const angebotsumme = Number(result.anonymized_data?.angebotssumme_brutto || result.anonymized_data?.angebotssumme_netto || 0);
      const positionsLeer = !Array.isArray(result.positions_nicht_in_liste) ? 0 : result.positions_nicht_in_liste.length;
      if (!savingsTotal && angebotsumme > 100) {
        const factor = deterministicSavingsFactor(checkNr);
        savingsTotal = Math.round(angebotsumme * factor);
        result.savings_total_eur = savingsTotal;
        result.savings_text = 'rund ' + Math.round(factor * 100) + ' % der Angebotssumme — Schätzwert ohne konkrete Preisliste';
        const findings = result.findings || [];
        findings.push({
          severity: 'amber',
          title: 'Schätzwert ohne Preislisten-Treffer',
          description: 'Keine Angebots-Position fand einen direkten Treffer in der Liftaro-Preisliste. Der ausgewiesene Ersparnis-Wert ist ein Schätzwert (zwischen 30–60 % der Angebotssumme, deterministisch aus der Check-Nr).',
          tag: 'Schätzwert · Preisliste-Lücke',
        });
        result.findings = findings;
      } else if (positionsLeer && savingsTotal) {
        const findings = result.findings || [];
        findings.push({
          severity: 'blue',
          title: 'Positionen ohne Preislisten-Referenz',
          description: positionsLeer + ' Angebots-Position(en) konnten nicht direkt gegen die Liftaro-Preisliste verglichen werden — diese Werte sind grobe Marktschätzungen.',
          tag: 'Preisliste-Lücke',
        });
        result.findings = findings;
      }

      if (role === 'eigentuemer' || role === 'verwalter') {
        const findings = result.findings || [];
        const hasRepairHint = findings.some(f => /reparatur.*(8\.?000|einsparen|liftaro.*pr[üu]f|zus[äa]tzlich)/i.test((f.title||'') + ' ' + (f.description||'')));
        if (!hasRepairHint) {
          findings.push({
            severity: 'blue',
            title: 'Zusätzliches Sparpotenzial bei Reparaturen',
            description: 'Diese Schätzung berücksichtigt nur Wartung und Notruf. Unterjährige Reparaturen sind nicht eingerechnet — gerade dort steckt oft das größte Potenzial. Durch regelmäßige Überprüfung der Reparatur-Rechnungen durch Liftaro lassen sich im Einzelfall bis zu 8.000 € zusätzlich einsparen.',
            tag: 'Reparatur-Prüfung · Liftaro-Service',
          });
          result.findings = findings;
        }
      }
    }

    let savingsIndividual = Number(result.savings_individual_eur || 0);
    if (!savingsIndividual && savingsTotal > 0 && meaPool > 0 && meaEigentuemer > 0) {
      savingsIndividual = Math.round(savingsTotal * meaEigentuemer / meaPool);
    }

    if (lead?.email) {
      const fullName = ((lead.vorname || '') + ' ' + (lead.nachname || '')).trim() || lead.email;
      const roleLabel = role === 'eigentuemer' ? 'Eigentümer'
                      : role === 'verwalter'  ? 'Hausverwalter'
                      :                          'Mieter';
      const checkTypeLabel = check_type === 'nebenkosten' ? 'Nebenkostenabrechnung'
                           : check_type === 'angebot'    ? 'Angebot'
                           :                                'Wartungsvertrag';
      const ampelLabel = result.ampel === 'rot' ? '🔴 Rot' : result.ampel === 'gelb' ? '🟡 Gelb' : result.ampel === 'gruen' ? '🟢 Grün' : '–';
      const fmt = (n: number) => Math.round(n).toLocaleString('de-DE');
      const noteLines = [
        '✅ ANALYSE ' + checkNr,
        '', 'Rolle: ' + roleLabel, 'Check-Typ: ' + checkTypeLabel, 'Ampel: ' + ampelLabel,
        savingsTotal ? 'Ersparnis Haus: ' + fmt(savingsTotal) + ' €/Jahr' : '',
        savingsIndividual ? 'Anteil indiv.: ' + fmt(savingsIndividual) + ' €/Jahr' : '',
        'Adresse: ' + (lead.adresse || '–'), '',
        '— Zusammenfassung —', result.summary || '(keine)',
      ].filter(Boolean);
      const title = '[Vorabcheck] ' + fullName + ' — ' + roleLabel + ' (' + checkNr + ')';
      upsertPipedriveLead({ name: fullName, email: lead.email, phone: lead.telefon || undefined, title, note: noteLines.join('\n') })
        .then(async (pd: any) => {
          if (!pd.ok || !pd.lead_id) return;
          const k = Deno.env.get("AIRTABLE_KEY"); const b = Deno.env.get("AIRTABLE_BASE_ID");
          if (!k || !b) return;
          try {
            const fr = await fetch('https://api.airtable.com/v0/' + b + "/Vorab-Checks?filterByFormula=" + encodeURIComponent("{check_nr}='" + checkNr + "'"),
              { headers: { Authorization: 'Bearer ' + k } });
            const rec = (await fr.json())?.records?.[0]?.id;
            if (!rec) return;
            await fetch('https://api.airtable.com/v0/' + b + '/Vorab-Checks/' + rec, {
              method: 'PATCH', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: { pipedrive_lead_id: pd.lead_id, pipedrive_person_id: String(pd.person_id || '') } }),
            });
          } catch (e) { /* */ }
        }).catch(e => console.warn('[Pipedrive] Vorabcheck failed:', e?.message || e));
    }

    const aufzugPositionen = Array.isArray(result.aufzug_positionen)
      ? result.aufzug_positionen
          .filter((p: any) => p && (p.text || p.betrag_eur))
          .map((p: any) => ({ text: String(p.text || '').trim(), betrag_eur: Number(p.betrag_eur || 0) }))
      : [];
    let aufzugGesamtkosten = Number(result.aufzug_gesamtkosten_eur || 0);
    if (!aufzugGesamtkosten && aufzugPositionen.length) {
      aufzugGesamtkosten = aufzugPositionen.reduce((s, p) => s + (Number(p.betrag_eur) || 0), 0);
    }

    return jsonResp({
      ampel: result.ampel,
      summary: result.summary,
      findings: result.findings || [],
      aufzug_count: aufzugCountUser,
      aufzug_positionen: aufzugPositionen,
      aufzug_gesamtkosten_eur: aufzugGesamtkosten,
      wartung_brutto_used: Number(result.anonymized_data?.betrag_aufzug_brutto || wartungBruttoUser || 0),
      wartung_brutto_source: wartungBruttoUser > 0 ? 'user' : 'ki', // Transparenz: woher kam der Wartungs-Wert?
      verteilerschluessel: String(result.verteilerschluessel || 'unbekannt'),
      parteien_count: Number(result.parteien_count || 0),
      mea_pool_total: meaPool,
      mea_eigentuemer: meaEigentuemer,
      savings_total_eur: savingsTotal,
      savings_individual_eur: savingsIndividual,
      savings_estimate_eur: savingsTotal, // Legacy für altes Frontend
      savings_text: result.savings_text || "",
      check_nr: checkNr,
      role: role,
      objekt_adresse: String(result.objekt_adresse || result.anonymized_data?.objekt_adresse || result.anonymized_data?.gebaeude_adresse || result.anonymized_data?.liegenschaft_adresse || '').trim(),
    }, 200, corsHeaders);

  } catch (e: any) {
    console.error("[liftaro-vorabcheck]", e);
    return jsonResp({ error: e.message || "Server-Fehler" }, 500, corsHeaders);
  }
}

function jsonResp(body: any, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
  });
  const json = await res.json();
  return !!json.success;
}

async function generateCheckNr(): Promise<string> {
  const year = new Date().getFullYear();
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `VC-${year}-${random}`;
}

async function saveToAirtable(data: {
  check_nr: string;
  check_type: string;
  role: string;
  lead: any;
  result: any;
  file_name: string;
  cost_eur: number;
  tokens_in: number;
  tokens_out: number;
  model: string;
  duration_ms: number;
}) {
  const key = Deno.env.get("AIRTABLE_KEY");
  const base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!key || !base) { console.warn("Airtable-Keys fehlen — überspringe Persistenz"); return; }
  const at = `https://api.airtable.com/v0/${base}`;
  const headers = { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };

  // Robust POST: bei 'Unknown field name: X' wird X aus dem Body entfernt und retried.
  // Damit ueberlebt der Save auch wenn die Airtable-Tabelle nicht alle Felder hat.
  async function atPostSafe(tableUrl: string, fieldsIn: Record<string, any>) {
    const fields = { ...fieldsIn };
    for (let i = 0; i < 20; i++) {
      try {
        const r = await fetch(tableUrl, { method: 'POST', headers, body: JSON.stringify({ fields }) });
        if (r.ok) return;
        const txt = await r.text();
        // Airtable returnt JSON wie {"error":{"type":"UNKNOWN_FIELD_NAME","message":"Unknown field name: \"role\""}}
        // → parse JSON + extrahiere msg, dann match Feldname.
        let badField = '';
        try {
          const j = JSON.parse(txt);
          const msg = j?.error?.message || j?.error || '';
          const m = String(msg).match(/Unknown field name:\s*"([^"]+)"/i);
          if (m) badField = m[1];
        } catch (_) { /* nicht JSON */ }
        if (badField && Object.prototype.hasOwnProperty.call(fields, badField)) {
          delete fields[badField];
          console.warn('[Airtable] retry ohne unbekanntes Feld:', badField);
          continue;
        }
        console.warn('[Airtable]', tableUrl.slice(-30), 'POST fehlgeschlagen:', txt.slice(0, 200));
        return;
      } catch (e: any) { console.warn('[Airtable]', tableUrl, e.message); return; }
    }
  }

  const totalEur = Number(data.result.savings_total_eur || data.result.savings_estimate_eur || 0);
  const indivEur = Number(data.result.savings_individual_eur || 0);

  await atPostSafe(`${at}/Vorabcheck-Leads`, {
    check_nr: data.check_nr,
    check_type: data.check_type,
    role: data.role,
    vorname: data.lead.vorname,
    nachname: data.lead.nachname,
    email: data.lead.email,
    telefon: data.lead.telefon || "",
    adresse: data.lead.adresse,
    file_name: data.file_name,
    savedAt: new Date().toISOString(),
  });

  const aufzugPositionen = Array.isArray(data.result.aufzug_positionen) ? data.result.aufzug_positionen : [];
  const aufzugPositionenText = aufzugPositionen
    .map((p: any) => (p.text || '') + ': ' + (Number(p.betrag_eur || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + ' €')
    .join('\n');
  let aufzugGesamtkosten = Number(data.result.aufzug_gesamtkosten_eur || 0);
  if (!aufzugGesamtkosten && aufzugPositionen.length) {
    aufzugGesamtkosten = aufzugPositionen.reduce((s: number, p: any) => s + (Number(p.betrag_eur) || 0), 0);
  }
  const aufzugCount = Number(data.result.aufzug_count || 0);
  // Kosten pro Aufzug pro Jahr (berechnet aus Gesamtkosten / Anzahl)
  const kostenProAufzugEur = aufzugCount > 0
    ? Math.round((aufzugGesamtkosten / aufzugCount) * 100) / 100
    : 0;
  // Objekt-Standort: KI extrahiert (objekt_adresse), Fallback auf User-eingegebene lead.adresse
  const objektAdresse = String(
    data.result.objekt_adresse ||
    data.result.anonymized_data?.objekt_adresse ||
    data.result.anonymized_data?.gebaeude_adresse ||
    data.result.anonymized_data?.liegenschaft_adresse ||
    data.lead?.adresse || ''
  ).trim();

  await atPostSafe(`${at}/Vorab-Checks`, {
    check_nr: data.check_nr,
    check_type: data.check_type,
    role: data.role,
    ampel: data.result.ampel,
    summary: data.result.summary,
    savings_estimate_eur: totalEur,
    savings_total_eur: totalEur,
    savings_individual_eur: indivEur,
    aufzug_count: aufzugCount,
    parteien_count: Number(data.result.parteien_count || 0),
    aufzug_gesamtkosten_eur: aufzugGesamtkosten,
    kosten_pro_aufzug_eur: kostenProAufzugEur,
    aufzug_positionen_text: aufzugPositionenText,
    aufzug_positionen_json: JSON.stringify(aufzugPositionen),
    objekt_adresse: objektAdresse,
    findings_json: JSON.stringify(data.result.findings || []),
    anonymized_data_json: JSON.stringify(data.result.anonymized_data || {}),
    savedAt: new Date().toISOString(),
  });

  await atPostSafe(`${at}/API-Cost-Log`, {
    check_nr: data.check_nr,
    endpoint: "vorabcheck",
    model: data.model,
    tokens_in: data.tokens_in,
    tokens_out: data.tokens_out,
    cost_eur: Math.round(data.cost_eur * 10000) / 10000,
    duration_ms: data.duration_ms,
    savedAt: new Date().toISOString(),
  });
}

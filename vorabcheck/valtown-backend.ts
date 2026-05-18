// ---
// LIFTARO VORABCHECK — val.town HTTP-Endpoint
//
// Setup-Anleitung:
//   1. Auf val.town anmelden (kostenlos): https://www.val.town
//   2. Neuen HTTP val anlegen (z.B. "liftaroVorabcheck")
//   3. Diesen Code einfügen
//   4. Im val.town Secrets-Tab folgende Variablen anlegen:
//        - ANTHROPIC_KEY          (dein Anthropic API Key)
//        - TURNSTILE_SECRET_KEY   (Cloudflare Turnstile Secret)
//        - AIRTABLE_KEY           (dein Airtable Personal Access Token)
//        - AIRTABLE_BASE_ID       (Base-ID der Liftaro-Base, z.B. appXXXX)
//   5. Den Endpoint deployen
//   6. Die HTTP-URL aus dem val (z.B. https://USERNAME-liftaroVorabcheck.web.val.run)
//      ins Frontend bei LIFTARO_API_URL eintragen
// ---

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";

// ---
// Konfiguration
// ---
const MODEL = "claude-sonnet-4-6";     // Upgrade von 4.5 → 4.6 für besseres Vision-Verständnis bei Tabellen
const COST_PER_M_INPUT_TOKENS = 3.0;   // $ pro 1M Input-Tokens (Sonnet 4.6 — Preise ähnlich 4.5)
const COST_PER_M_OUTPUT_TOKENS = 15.0; // $ pro 1M Output-Tokens
const USD_TO_EUR = 0.92;

// ---
// Prompt-Loader — liest Custom-Prompts aus Airtable mit 5-Min-Cache.
// Fallback auf die hardcoded DEFAULT_SYSTEM_PROMPTS weiter unten.
// ---
let _promptCache: Record<string, string> | null = null;
let _promptCacheTs = 0;
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

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

// ---
// Pipedrive-Integration: Lead pro Vorabcheck + pro Kontaktformular.
// Token & Domain liegen in der Liftaro-Master-Base als Keys
// 'pipedriveDomain' und 'pipedriveApiToken'. 5-Min-Cache.
// ---
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
  // Legacy-Wrapper — leitet auf den neuen upsertPipedriveLead um (Dedup-fähig).
  return upsertPipedriveLead(input);
}

// ---
// upsertPipedriveLead — Dedup per Email:
//   1. Person via Email-Suche finden, sonst anlegen
//   2. Vorhandenen offenen (nicht-archivierten) Lead der Person nutzen,
//      sonst neuen anlegen
//   3. Note in jedem Fall ANHÄNGEN (Verlauf bleibt erhalten)
//
// Resultat: 1 Pipedrive-Lead pro Kontakt, alle Touchpoints als Notes.
// ---
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

    // 1a) Person-Suche per Email
    if (input.email) {
      try {
        const searchUrl = base + '/persons/search?fields=email&exact_match=true&limit=5&term=' +
          encodeURIComponent(input.email) + '&api_token=' + encodeURIComponent(cfg.token);
        const sr = await fetch(searchUrl);
        const sd = await sr.json();
        if (sd?.success && sd.data?.items?.length) {
          // Erstes exaktes Match
          personId = sd.data.items[0].item?.id || null;
          if (personId) personExisted = true;
        }
      } catch (e) {  }
    }

    // 1b) Person anlegen, wenn nicht gefunden
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

    // 2) Organization (optional) — nur bei neuen Personen / neuen Leads
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

    // 3a) Existierenden, nicht-archivierten Lead der Person finden
    let leadId: string | null = null;
    let leadReused = false;
    try {
      const leadsUrl = base + '/leads?person_id=' + personId + '&archived_status=not_archived&limit=20&api_token=' + encodeURIComponent(cfg.token);
      const lr = await fetch(leadsUrl);
      const ld = await lr.json();
      if (ld?.success && Array.isArray(ld.data) && ld.data.length > 0) {
        // Neuesten offenen Lead nehmen (Pipedrive sortiert default ASC nach Erstelldatum)
        const sorted = ld.data.slice().sort((a: any, b: any) =>
          String(b.add_time || '').localeCompare(String(a.add_time || ''))
        );
        leadId = sorted[0].id;
        leadReused = true;
      }
    } catch (e) {  }

    // 3b) Neuen Lead anlegen, wenn keiner offen ist
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

    // 4) Note IMMER anhängen — egal ob neuer oder reused Lead
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

// ---
// HAUSVERWALTUNGS-SUCHE (Phase 1: Pipedrive-DB-Lookup, Phase 4: Serper+KI)
// ---
// Whitelist für allgemeine, nicht-personalisierte Geschäfts-Mails einer HV.
// Nur diese Local-Parts gelten als "öffentlich" und werden auto-befüllt.
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
  // Exakter Match: "info@…" → true. "info.maier@…" → false (zu spezifisch).
  return HV_GENERIC_EMAIL_PREFIXES.includes(local);
}

// Persons einer Organization → erste generische (allgemeine) Email zurückgeben.
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

// Pipedrive-Org-Suche nach Namen — strikt (case-insensitive Substring-Check)
// + Score-Schwelle, damit Pipedrive's Fuzzy-Search keine zufälligen Treffer durchlässt.
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
        // Substring-Match: term muss case-insensitive im Namen vorkommen
        const nameLow = String(x.item.name).toLowerCase();
        if (!nameLow.includes(termLow)) return false;
        // Score-Schwelle: 0.3 ist ein moderater Cut-Off, Pipedrive's Top-Match liegt typisch bei 0.5-1.0
        return x.score >= 0.3 || term.length >= 5; // bei längerem Term Score-Toleranz lockern
      })
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit)
      .map((x: any) => x.item);
    return filtered;
  } catch (e) { console.warn('[Pipedrive] findOrgsByName:', e); return []; }
}

// Single-Treffer-Wrapper für Submit-Pfad
async function findPipedriveOrgByName(name: string): Promise<any | null> {
  const hits = await findPipedriveOrgsByName(name, 1);
  return hits.length ? hits[0] : null;
}

// Allgemeine Geschäfts-Email einer Org aus den verknüpften Persons holen.
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

// Org in Pipedrive anlegen (für KI-Fallback, Phase 4).
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
    // Custom-Field „Quelle" + Website können später hinzugefügt werden, sobald
    // die Field-IDs in Pipedrive bekannt sind. Vorerst nur Name + optional Address.
    if (input.city) orgBody.address = input.city;
    const orgRes = await fetch(base + '/organizations' + auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orgBody),
    });
    const orgData = await orgRes.json();
    if (!orgData.success) return { ok: false, error: 'Org-Create: ' + JSON.stringify(orgData.error || {}).slice(0, 200) };
    const orgId = orgData.data.id;
    // Wenn allgemeine Email vorhanden: als „Default-Person" der Org anlegen
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

// Person an Org linken (User → HV-Org).
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

// HV-Lead erzeugen — separater Lead aus B2B-Sicht.
// Pipeline: orgId ist der „Eigentümer" des Leads (B2B-Pipeline).
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
    // 1. Existierenden offenen HV-Lead suchen → Dedup pro Org
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

    // 2. Neuen HV-Lead anlegen wenn keiner offen
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

    // 3. Note mit Vorabcheck-Kontext anhängen (jedes Mal)
    const fmt = (n: number) => Math.round(n).toLocaleString('de-DE');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const roleLabel = input.role === 'eigentuemer' ? 'Eigentümer'
                    : input.role === 'verwalter'  ? 'Hausverwalter'
                    :                                'Mieter';
    const noteLines = [
      '🕒 ' + stamp,
      '',
      'HV-Lead automatisch erzeugt aus einem Liftaro-Vorabcheck.',
      '',
      'Trigger-Vorabcheck:',
      '  Check-Nr: ' + input.checkNr,
      '  Rolle des Auftraggebers: ' + roleLabel,
      '  Name: ' + input.userFullName,
      input.userEmail ? '  E-Mail: ' + input.userEmail : '',
      input.savingsTotal ? '  Identifiziertes Sparpotenzial: ' + fmt(input.savingsTotal) + ' € / Jahr' : '',
      '',
      'Vertriebs-Aufhänger:',
      '  Der Auftraggeber hat das Sparpotenzial bereits an diese HV weitergeleitet.',
      '  Möglicher Folgekontakt: Konkrete Einsparungsberechnung + Light-Paket-Angebot.',
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

// ---
// Preisreferenzen — Marktmedian-Liste pro Angebots-Position.
// Wird bei check_type=angebot der KI als Kontext mitgegeben.
// 5-Min-Cache wie bei den Custom-Prompts.
// ---
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

// Deterministischer Pseudo-Random aus check_nr (für Fallback wenn KI nichts in Preisliste findet).
// 30 % bis 60 % Ersparnis vom Angebotsbetrag — Wert pro check_nr stabil.
function deterministicSavingsFactor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return 0.30 + ((h >>> 0) % 1000) / 1000 * 0.30; // 0,30 – 0,60
}

// ---
// Rollen-spezifischer Kontext, der vor jeden Default-Prompt
// gehängt wird. Sorgt für die korrekte rechtliche Einordnung
// (Mieter vs. WEG-Eigentümer vs. Verwalter).
// ---
const ROLE_CONTEXTS: Record<string, string> = {
  mieter: `ROLLEN-KONTEXT: MIETER (Wohnraum-Mietvertrag)

Der Nutzer ist Mieter. Folgendes gilt rechtlich:
- § 2 BetrKV definiert abschließend, welche Kosten als Betriebskosten umgelegt werden dürfen.
- Aufzug-Wartung, Strom, Aufsicht/Bedienung, TÜV/ZÜS-Prüfung, Reinigung → umlagefähig.
- Reparaturen, Instandsetzung, Modernisierung, Verwaltungskosten → NICHT umlagefähig (§ 1 Abs. 2 BetrKV).
- Bei Vollwartungsverträgen MUSS ein Vorwegabzug für Instandsetzungs-Anteile erfolgen (BGH VIII ZR 123/14, ca. 20–50 % je Vertragsumfang). Fehlender Vorwegabzug = unzulässige Umlage.
- § 556 Abs. 3 BGB: 12 Monate Einwendungsfrist ab Erhalt der Nebenkostenabrechnung.
- Erdgeschoss-Mieter: Aufzugskosten nur dann zulässig, wenn vertraglich vereinbart (LG-Rechtsprechung uneinheitlich).

⚠ VORSICHTS-REGEL für Mieter (sehr wichtig):
Markiere einen Posten NUR DANN als rechtswidrig/fehlerhaft (Severity "warn"/Ampel "rot"), wenn der Verstoß
EINDEUTIG aus dem Dokument hervorgeht. Beispiele für eindeutig:
  · Position "Reparatur Aufzug" oder "Instandsetzung Aufzug" wird unter umlagefähige Betriebskosten gezogen.
  · Position "Modernisierung Aufzug" wird umgelegt.
  · Explizit erwähnter Vollwartungsvertrag OHNE Vorwegabzug.
NICHT als Fehler markieren bei (nicht eindeutigen Hinweisen):
  · Hohe Wartungspauschale alleine — kann viele plausible Gründe haben (Anlagengröße, Hochhaus, Notruf, Hersteller-Service).
  · Unklarer Vertragstyp — wenn das Dokument nicht eindeutig Vollwartung sagt: kein Vorwegabzug-Befund.
  · Nicht erkennbare Verteilerschlüssel-Diskussion (Erdgeschoss etc.) — ohne Vertragsklausel-Info bleibt das spekulativ.
Bei Unsicherheit: severity "blue" (Hinweis "bitte separat prüfen lassen") oder "amber" — NIEMALS "warn" auf Verdacht.
Die Ampel "rot" darf nur kommen, wenn es mindestens einen "warn"-Befund mit eindeutiger Belegstelle aus dem Dokument gibt.

SPRACHE: Bei eindeutigen Verstößen klar und durchsetzungs-orientiert formulieren mit §-Bezug (z.B. "Verstoß gegen § 1 Abs. 2 BetrKV"). Bei Zweifelsfällen offen formulieren ("Hinweis", "bitte prüfen lassen", "ggf. separat klären"). KEINE Rechtsberatung.`,

  eigentuemer: `ROLLEN-KONTEXT: EIGENTÜMER (WEG-Mitglied oder Selbstnutzer)

Der Nutzer ist Eigentümer. Folgendes gilt:
- Alle Aufzugskosten (Wartung, Reparatur, Instandsetzung) werden in der WEG-Abrechnung umgelegt — es gibt KEINE Umlage-Beschränkung wie bei Mietern.
- Relevante Prüfung: Marktangemessenheit der Konditionen, Vertragsoptimierungs-Potenzial, Vollwartung vs. Teilwartung, Servicestunden-Sätze, Vertragslaufzeit/Kündigungsfristen.
- Befunde wie "Reparaturen versteckt" sind hier KEIN Rechtsverstoß, sondern Transparenz-/Verhandlungs-Argument.
- Eigentümer kann als Vertragspartner direkt eine Optimierung anstoßen.

SPRACHE: Sachlich, wirtschaftlich orientiert. §-Bezug nur wo relevant (z.B. WEG-Recht bei Verteilerschlüssel). Fokus auf konkrete Einsparungs-Hebel.`,

  verwalter: `ROLLEN-KONTEXT: HAUSVERWALTER (Verwaltungsmandat)

Der Nutzer ist Hausverwalter. Folgendes gilt:
- Verwaltet möglicherweise mehrere Anlagen → Ersparnis-Hochrechnung "pro Anlage + portfolio-weit" ist besonders relevant.
- Hat Verantwortung gegenüber Eigentümern (WEG) bzw. Vermietern und muss wirtschaftlich + rechtssicher handeln.
- Kann als Vertragspartner direkt Vertragsoptimierungen einleiten.
- Relevante Prüfung: Optimierungs-Hebel, Compliance-Risiken (z.B. fehlender Vorwegabzug bei Mieter-Umlage), Marktbenchmarks.

SPRACHE: Professionell, knapp, kennzahlen-orientiert. Bezugnahme auf §§ wo relevant — insbesondere bei Konstellationen, wo Mietumlage betroffen ist (dann Mietrecht-Hinweis).`,
};

function buildSystemPrompt(checkType: string, role: string, customMap: Record<string, string>): string | null {
  // 1. Custom-Prompt aus Airtable bevorzugen (Schlüssel "checkType.role" oder "checkType")
  if (customMap[checkType + '.' + role]) return customMap[checkType + '.' + role];
  if (customMap[checkType]) return customMap[checkType];

  // 2. Default-Prompt + Rollen-Kontext vorne anhängen
  const base = DEFAULT_SYSTEM_PROMPTS[checkType];
  if (!base) return null;
  const roleCtx = ROLE_CONTEXTS[role] || ROLE_CONTEXTS.mieter;
  return roleCtx + '\n\n────────────────────────────────────────\n\n' + base;
}

// ---
// DEFAULT-System-Prompts pro Check-Typ (Fallback, wenn nichts in
// Airtable hinterlegt ist).
//
// HINWEIS: Diese Default-Prompts werden zur Laufzeit mit einem
// rollen-spezifischen Vorspann (siehe ROLE_CONTEXTS) kombiniert.
// ---
const DEFAULT_SYSTEM_PROMPTS: Record<string, string> = {
  nebenkosten: `Du bist Aufzug-Experte und Bau-/Mietrechts-Analyst bei Liftaro. Du prüfst Nebenkostenabrechnungen auf die Aufzug-Position.

═══════════════════════════════════════════
TASK 1 (HÖCHSTE PRIORITÄT): DATEN EXTRAHIEREN
═══════════════════════════════════════════
Suche im Dokument die Aufzug-Wartungs-Position. Typische Bezeichnungen:
  · "Aufzugskosten/Wartung/TÜV"
  · "Aufzugswartung Haus X"
  · "Aufzugswartung"
  · "Aufzug Wartung"
  · "Wartung Aufzug"
  · "Aufzugskosten" (wenn nichts spezifischeres da ist)

Daraus extrahiere den **GESAMT-Wartungsbetrag** — das ist der Wert in der
GESAMT-Spalte (auch genannt: "Gesamt", "Verteilungsrelevante Beträge",
"Ausgaben Gesamt", "Brutto"). Das ist NICHT "Ihr Anteil" / "Ihr Betrag".

KONKRETE BEISPIELE (du musst genau lesen können):

Beispiel A — tabellarisch mit MEA-Schlüssel:
  Konto  Bezeichnung                  Verteilungsrelevante Beträge  Schlüssel  Gesamt  Ihr Anteil  Ihr Betrag
  5000   Aufzugskosten/Wartung/TÜV    8.832,46                       MEA        10000   81          71,54
  → betrag_aufzug_brutto = 8832.46  (NICHT 71.54!)

Beispiel B — Haus-Position:
  Aufzugswartung Haus 9   Miteigentumsanteile   17.051   1.263   2.100,00   155,55
  → betrag_aufzug_brutto = 2100.00  (NICHT 155.55!)

Beispiel C — Einfach:
  Aufzugswartung   450,00 €   (Einheit)
  → betrag_aufzug_brutto = 450.00

Wichtige Regeln zur Extraktion:
- IMMER den größten EUR-Wert der Aufzug-Wartungs-Zeile nehmen, NIE den Eigentümer-Anteil
- Bei mehreren Aufzug-Wartungs-Positionen (z.B. mehrere Häuser): ADDIERE die Gesamt-Werte
- Wenn du dir bei einem Wert nicht 100 % sicher bist: 0 zurückgeben, NIE raten
- Tausender-Trenner ist Punkt, Dezimal-Komma: "8.832,46" = 8832.46

═══════════════════════════════════════════
TASK 2: RECHTLICHE BEWERTUNG (kurz)
═══════════════════════════════════════════

🎯 ZWEI SEPARATE BEWERTUNGEN — IMMER BEIDE DURCHFÜHREN:

A) RECHTLICHE KORREKTHEIT (steuert "ampel" + warn-Findings)
   - Wird die Abrechnung rechtlich/formal korrekt aufgestellt?
   - Bei sauberer Trennung umlagefähig/nicht-umlagefähig: Ampel "gruen"
   - Bei eindeutigen Verstößen: Ampel "gelb"/"rot"

B) MARKT-OPTIMIERUNG (steuert "savings_total_eur" — UNABHÄNGIG von A!)
   - Vergleich der Wartungskosten mit dem Liftaro-Marktmedian (980 €/Anlage/Jahr).
   - Eine "rechtlich saubere" Abrechnung kann trotzdem WIRTSCHAFTLICH überteuert sein —
     das ist KEIN Rechtsverstoß, aber ein Optimierungs-Hinweis für den Auftraggeber.
   - Markt-Optimierung IMMER durchführen, auch wenn Ampel "gruen" ist.
   - Bei Wartung über Median: Erzeuge ein "amber" oder "blue" Finding "Optimierungspotenzial:
     Wartungspauschale X EUR liegt Y EUR über dem Marktmedian von 980 EUR. Geschätzte Ersparnis
     bei Neuausschreibung: Z EUR/Jahr."
   - savings_total_eur = (tatsächliche_Wartung_pro_Anlage − 980) × Anzahl_Aufzüge
     (exakte Differenz zum Marktmedian — kein Sicherheits-/Verhandlungsfaktor abziehen)
     (NICHT mehr null setzen, nur weil Ampel grün ist!)
   - savings_text z.B. "rund X % der bisherigen Wartungskosten durch marktgerechte Konditionen"

⚠ ANTI-HALLUZINATIONS-REGEL (sehr wichtig):
- Stelle NIE Behauptungen auf, die nicht direkt aus dem Dokument belegbar sind.
- "Vollwartungsvertrag" darfst Du NUR annehmen, wenn das Wort/der Begriff (oder eindeutige Synonyme wie "Vollwartung", "inkl. Reparaturen", "all-inclusive Wartung") tatsächlich im Dokument steht.
- Wenn nur eine Position "Wartung" und separat eine Position "Instandhaltung/Reparatur" auftaucht → das spricht STARK GEGEN Vollwartung. In diesem Fall KEIN Vorwegabzug-Befund erzeugen.
- Wenn Du den Vertragstyp aus dem Dokument NICHT bestimmen kannst → "vollwartung_erwaehnt": false und KEIN Finding zum Vorwegabzug. Stattdessen optional ein blue-Finding: "Vertragstyp unklar — bitte Wartungsvertrag separat prüfen lassen."

⚠ ZUSÄTZLICHE VORSICHTS-REGEL bei Mieter-Rolle:
Bei Nebenkostenabrechnungen, die einem MIETER vorgelegt werden, gilt: Markiere die Abrechnung NUR DANN als
fehlerhaft (Ampel "rot" oder Severity "warn"), wenn der Fehler OFFENSICHTLICH und EINDEUTIG aus dem Dokument
hervorgeht (z.B. eine Position "Reparatur Aufzug" steht klar unter umlagefähigen Betriebskosten, oder ein
ausdrücklicher Vollwartungsvertrag ohne ausgewiesenen Vorwegabzug). Wenn nur ein Verdacht besteht oder das
Dokument unklar ist → severity "blue"/"amber" (Hinweis statt Verstoß), Ampel "gruen" oder "gelb".
Liftaro will Mieter NICHT zu unbegründeten Streitigkeiten ermutigen — nur bei eindeutigen Verstößen klare Kante.

PRÜFE FOLGENDE PUNKTE:

1. UMLAGEFÄHIGKEIT (§ 2 Nr. 7 BetrKV)
   - Umlagefähig: Wartung, Strom, Aufsicht, TÜV (ZÜS), Reinigung
   - NICHT umlagefähig (§ 1 Abs. 2 BetrKV): Reparaturen, Instandsetzung, Modernisierung
   - Bei Mieter: Verstöße klar als solche benennen mit §-Bezug.
   - Bei Eigentümer/Verwalter: als Transparenz-Hinweis formulieren (kein Rechtsverstoß).
   - WICHTIG: Wenn Instandhaltung in der Abrechnung BEREITS unter "nicht umlagefähig" geführt wird → das ist KORREKT, kein Verstoß. Lobe das ausdrücklich.

2. VOLLWARTUNGSVERTRAG — nur prüfen wenn EXPLIZIT erwähnt
   - Voraussetzung: Das Dokument erwähnt Vollwartung wörtlich.
   - Bei expliziter Vollwartung + Mieter-Umlage muss ein Vorwegabzug für Instandsetzung erfolgen (20–50 %, BGH VIII ZR 123/14).
   - Wenn nicht ausgewiesen UND Vollwartung explizit → Rotflag bei Mieter.
   - Bei separat ausgewiesener Instandhaltung → KEIN Vollwartungs-Vermutung, KEIN Vorwegabzug-Befund.

3. WARTUNGSPAUSCHALE — LIFTARO-REFERENZWERT (verbindlich, NICHT VERHANDELBAR)
   - **Marktmedian Wohnaufzug INKL. Notruf/Bereitschaftsdienst: 980 €/Jahr je Anlage**
   - Dieser Wert ist die Liftaro-Referenz aus Marktdaten. Verwende ihn als HARTE Vergleichsbasis. Erfinde KEINE anderen Median-Werte.
   - **WICHTIG — Diskretion bei der Ausgabe:** Den konkreten Wert "980 €" NIE wörtlich in summary, savings_text oder findings nennen. Stattdessen sprich vom "branchenüblichen Marktmedian", "Marktreferenz für Wartung und Notruf" oder "marktüblichem Vergleichswert". Die Differenz und die Ersparnis dürfen genannt werden — nur die Median-Zahl selbst nicht.

   PFLICHT-RECHENGANG (immer durchführen):
   a) Hole den Aufzug-Brutto-Betrag aus der Abrechnung (z.B. "Aufzugswartung Haus 9: 2.100 €")
   b) Teile durch aufzug_count (z.B. 2.100 / 1 = 2.100 € pro Anlage und Jahr)
   c) Vergleiche mit 980 €:
      · pro_anlage ≤ 1.200 → marktüblich, kein Befund (savings_total_eur = 0)
      · 1.200 < pro_anlage ≤ 1.500 → leicht erhöht (blue/amber-Hinweis)
      · 1.500 < pro_anlage ≤ 1.800 → deutlich über Markt (amber/warn)
      · pro_anlage > 1.800 → KLAR ZU TEUER (warn, konkrete Ersparnis ausweisen)
   d) Ersparnis bei Neuausschreibung zum Median = (pro_anlage − 980) × aufzug_count
      (KEINEN Verhandlungs-Faktor abziehen — wenn der Vertrag auf Median geht, ist genau das die Ersparnis.)

   KONKRETES BEISPIEL (für Konsistenz-Check):
   "Aufzugswartung Haus 9: 2.100 €, 1 Aufzug"
   → pro_anlage = 2.100 €
   → 2.100 > 1.800 → KLAR ZU TEUER
   → savings_total_eur = (2.100 − 980) × 1 = 1.120 € (intern berechnen, NICHT den Median-Wert anzeigen)
   → savings_text = "rund 53 % der bisherigen Wartungskosten durch Neuausschreibung zu marktüblichen Konditionen"
   → summary muss das WIDERSPIEGELN, NICHT "unter Marktmedian" behaupten!
   → finding-Description: "liegt rund 1.120 € über dem branchenüblichen Marktmedian" (KEINE konkrete 980-Zahl!)

   VERBOT: Schreibe NIE "unter Marktmedian" oder "marktüblich" wenn pro_anlage > 1.200 €.
   Achtung: Hohe Beträge können in Sondersituationen gerechtfertigt sein (hochwertige/seltene Anlage, mehrere Wartungen p.a., Großgebäude mit ständigem Notruf-Bedarf). Bei Anhaltspunkten dafür: Befund-Severity um eine Stufe abmildern — aber NICHT die mathematische Aussage drehen.

4. SERVICESTUNDEN-SATZ
   - Marktüblich 95–125 €/h, regional unterschiedlich
   - >140 €/h → gelb, >160 €/h → rot

5. ANZAHL WARTUNGEN P.A.
   - TRBS 1201 Teil 4: 2 Wartungen/Jahr für Wohnaufzüge ausreichend
   - 4 Wartungen → gelb (kann ok sein bei stark genutzten Anlagen)

6. VERTEILUNGSSCHLÜSSEL
   - Erdgeschoss-Mieter zahlt nur wenn vertraglich vereinbart (Mieter-spezifisch)
   - Übliche Schlüssel: m² Wohnfläche oder Person oder Miteigentumsanteile (MEA)

7. FRIST § 556 Abs. 3 BGB (nur Mieter)
   - 12 Monate ab Erhalt der Abrechnung für Einwendungen

8. ANLAGEN-ERFASSUNG (immer extrahieren — wichtig für Hochrechnung)
   - aufzug_count: Wie viele Aufzüge sind in der Abrechnung enthalten?
     · "Aufzugswartung Haus 9" → 1 Aufzug
     · "Aufzugswartung Haus 9, 11, 15" → 3 Aufzüge
     · Wenn nicht ersichtlich → 0 (heißt: unbekannt)

   - verteilerschluessel: WELCHER Schlüssel wird für die Aufzug-Position genutzt?
     · "mea" → Miteigentumsanteile (üblich bei WEG)
     · "qm" → Wohnfläche
     · "einheit" → gleichmäßig pro Wohneinheit
     · "person" → pro Person
     · "unbekannt" → wenn nicht ersichtlich

   - WENN verteilerschluessel === "mea" (Miteigentumsanteile):
     · mea_pool_total: Die GESAMT-MEA der Aufzug-Position (das ist NICHT 100.000 — sondern nur die Summe für den Aufzug-Verteilerschlüssel, z.B. 17.051 für "Aufzugswartung Haus 9").
     · mea_eigentuemer: Der MEA-Anteil des anfragenden Eigentümers an der Aufzug-Position (z.B. 1.263).
     · parteien_count: NUR setzen, wenn aus dem Dokument klar hervorgeht, wie viele Parteien sich den Aufzug-Pool teilen. Sonst 0. NIE die "73 Einheiten" einer anderen Position (z.B. Hausreinigung) übernehmen — der Aufzug betrifft oft nur EIN Haus mit weniger Parteien.

   - WENN verteilerschluessel === "einheit" (gleiche Anzahl pro Partei):
     · parteien_count: Anzahl Einheiten am Verteilerschlüssel der Aufzug-Position direkt (z.B. wenn Aufzug-Position "Einheiten 13" → 13 Parteien).
     · mea_pool_total / mea_eigentuemer leer/0 lassen.

   - WENN verteilerschluessel === "qm" oder "person":
     · Beides leer lassen (nur individuelle Berechnung aus "Ihr Anteil EUR" möglich).
     · parteien_count: 0, sofern nicht eindeutig ableitbar.

   - Mathematische Konsistenz: Die KI MUSS sicherstellen, dass aufzug_count * Wartung pro Anlage ≈ Gesamt-Aufzug-Position. Wenn das nicht passt → Werte korrigieren.

ANTWORTE NUR MIT JSON, OHNE MARKDOWN-CODE-BLOCKS:
{
  "ampel": "gruen" | "gelb" | "rot",
  "summary": "Ein-Satz-Bewertung",
  "findings": [
    {
      "severity": "warn" | "amber" | "blue",
      "title": "Kurze Überschrift",
      "description": "1–2 Sätze Erklärung mit konkreten Beträgen wenn möglich",
      "tag": "z.B. § 2 Nr. 7 BetrKV oder Position 4.2"
    }
  ],
  "aufzug_count": Zahl (Anzahl erkannter Aufzüge in der Abrechnung, 0 wenn unklar),
  "verteilerschluessel": "mea" | "qm" | "einheit" | "person" | "unbekannt",
  "parteien_count": Zahl (NUR bei verteilerschluessel "einheit" oder "person", sonst 0 — siehe Regel oben),
  "mea_pool_total": Zahl (Gesamt-MEA der Aufzug-Position, NUR bei verteilerschluessel "mea"; sonst 0),
  "mea_eigentuemer": Zahl (MEA-Anteil des Anfragenden, NUR bei verteilerschluessel "mea"; sonst 0),
  "savings_total_eur": Zahl (geschätzte jährliche Gesamtersparnis fürs ganze Haus in EUR, 0 wenn keine),
  "savings_individual_eur": Zahl (geschätzte jährliche Ersparnis für die anfragende Partei in EUR — bei MEA: savings_total_eur * mea_eigentuemer / mea_pool_total; bei Einheit: savings_total_eur / parteien_count; 0 wenn nicht berechenbar),
  "savings_estimate_eur": Zahl (Legacy-Feld; identisch zu savings_total_eur),
  "savings_text": "z.B. 'rund 40% der bisherigen Aufzug-Kosten'",
  "anonymized_data": {
    "abrechnungszeitraum": "z.B. 2024",
    "betrag_aufzug_brutto": Zahl (ABSOLUTER Wartungsbetrag aus Zeile "Aufzugswartung … X EUR" Gesamt-Spalte; NICHT die Differenz zum Median, NICHT der Eigentümer-Anteil, NICHT die Ersparnis. Bei "Aufzugswartung Haus 9: 2.100 EUR" → 2100.),
    "verteilerschluessel": "mea" | "qm" | "einheit" | "person" | "unbekannt",
    "vollwartung_erwaehnt": true | false,
    "vorwegabzug_ausgewiesen": true | false,
    "anzahl_wartungen": Zahl | null,
    "anzahl_aufzuege": Zahl,
    "mea_pool_total": Zahl,
    "anbieter_branche": "kone" | "schindler" | "tk-elevator" | "otis" | "sonstige" | "unbekannt"
  },
  "aufzug_positionen": [
    { "text": "Wörtlicher Positionsname aus der Abrechnung (z.B. 'Aufzugskosten/Wartung/TÜV')",
      "betrag_eur": Zahl (Gesamt-Betrag dieser Position; aus der Gesamt-Spalte) }
  ],
  "aufzug_gesamtkosten_eur": Zahl (Summe ALLER Aufzug-bezogenen Positionen aus der Abrechnung — Wartung, Notruf, Instandhaltung, TÜV, Strom, etc. zusammen)
}

WICHTIG zu aufzug_positionen + aufzug_gesamtkosten_eur:
- Finde JEDE Zeile in der Abrechnung, die "Aufzug" / "Aufzugs…" im Namen enthält (Wartung, Instandhaltung, Notruf, TÜV, Strom Aufzugsanlage, …).
- Übernimm den Positions-Text 1:1 wörtlich aus der Abrechnung (kein Umformulieren, kein Kürzen).
- betrag_eur ist immer der GESAMT-Betrag der Zeile (aus der Gesamt-Spalte), NICHT der Eigentümer-Anteil.
- aufzug_gesamtkosten_eur = Summe aller betrag_eur in aufzug_positionen. Beide Felder müssen konsistent sein.
- Wenn keine Aufzug-Position gefunden: leeres Array [] und 0.

WICHTIG: anonymized_data darf KEINE personenbezogenen Daten enthalten (keine Namen, Adressen, Kontonummern).`,

  angebot: `Du bist Aufzug-Experte bei Liftaro. Du prüfst Reparatur- oder Wartungs-Angebote auf Plausibilität.

PRÜFE:
1. Marktüblichkeit der Positionspreise (Reparaturkomponenten, Servicestunden)
2. Vollständigkeit (Gewährleistung, Lieferzeit, Anschrift, Steuer-ID)
3. Auffällige Klauseln (lange Bindefristen, Preisgleitklauseln)
4. Anlagen-Bezug: wie viele Aufzüge betrifft das Angebot? Welche Anzahl Parteien profitiert?

LIFTARO-REFERENZWERTE (verbindlich, aus Marktdaten):
- Wartungspauschale inkl. Notruf: **Median 980 €/Jahr** je Wohnaufzug
- Servicestunden-Satz: 95–125 €/h Wohnaufzug, 110–145 €/h Gewerbe
- Bei Wartungsangeboten > ~1.500 €/Jahr deutlich über Markt → konkret Ersparnis ausweisen
- Geschätzte Ersparnis bei Neuausschreibung = (Angebotsbetrag − 980) (exakte Differenz)

Bei Mieter: §-Bezug bei umlagefähigkeitsrelevanten Themen (Reparatur vs. Wartung).
Bei Eigentümer/Verwalter: wirtschaftlich/sachlich.

ANTWORTE NUR MIT JSON:
{
  "ampel": "gruen" | "gelb" | "rot",
  "summary": "...",
  "findings": [{ "severity": "warn"|"amber"|"blue", "title": "...", "description": "...", "tag": "..." }],
  "aufzug_count": Zahl,
  "parteien_count": Zahl,
  "savings_total_eur": Zahl,
  "savings_individual_eur": Zahl,
  "savings_estimate_eur": Zahl,
  "savings_text": "...",
  "anonymized_data": {
    "angebotssumme_netto": Zahl,
    "angebotssumme_brutto": Zahl,
    "gewaehrleistung_monate": Zahl | null,
    "lieferzeit_wochen": Zahl | null,
    "anzahl_aufzuege": Zahl,
    "anbieter_branche": "..."
  }
}`,

  vertrag: `Du bist Aufzug-Experte bei Liftaro. Du prüfst Wartungsverträge auf ungünstige Konditionen.

PRÜFE:
1. Laufzeit & Kündigungsfrist (typisch: 3 Monate vor Ablauf, max. 5 Jahre Erstlaufzeit)
2. Vertragstyp (Voll- vs. Teilwartung) — bei Mieter-Umlage: Vorwegabzug-Pflicht für Instandsetzung (BGH VIII ZR 123/14)
3. Preisgleitklauseln
4. Anzahl Wartungen p.a. (TRBS 1201 Teil 4)
5. Bereitschaftsdienst / Notruf-Kosten
6. Anzahl Anlagen im Vertrag + Anzahl Parteien zur Ersparnis-Hochrechnung

LIFTARO-REFERENZWERTE (verbindlich, aus Marktdaten):
- Wartungspauschale inkl. Notruf/Bereitschaft: **Median 980 €/Jahr** je Wohnaufzug
- Bewertung pro Anlage:
  · bis ~1.200 €/Jahr → marktüblich
  · 1.200–1.500 € → leicht erhöht (Hinweis)
  · 1.500–1.800 € → deutlich über Markt (amber/warn, Optimierung nennen)
  · über 1.800 € → klar zu teuer (warn, Ersparnis konkret ausweisen)
- Geschätzte Ersparnis bei Neuausschreibung = (Vertragsbetrag − 980) (exakte Differenz)
- Bei mehreren Anlagen im Vertrag immer pro Anlage rechnen (Summe ÷ Anzahl)

Bei Mieter: Mietrechtliche Konsequenzen mit §-Bezug benennen, wenn die Vertragsgestaltung die Umlagefähigkeit beeinflusst.
Bei Eigentümer/Verwalter: Optimierungs- und Verhandlungs-Hebel.

ANTWORTE NUR MIT JSON:
{
  "ampel": "gruen" | "gelb" | "rot",
  "summary": "...",
  "findings": [{ "severity": "warn"|"amber"|"blue", "title": "...", "description": "...", "tag": "..." }],
  "aufzug_count": Zahl,
  "parteien_count": Zahl,
  "savings_total_eur": Zahl,
  "savings_individual_eur": Zahl,
  "savings_estimate_eur": Zahl,
  "savings_text": "...",
  "anonymized_data": {
    "vertragstyp": "vollwartung" | "teilwartung" | "unbekannt",
    "laufzeit_jahre": Zahl | null,
    "kuendigungsfrist_monate": Zahl | null,
    "kosten_pro_jahr": Zahl,
    "anzahl_wartungen": Zahl | null,
    "anzahl_aufzuege": Zahl,
    "anzahl_parteien": Zahl,
    "anbieter_branche": "..."
  }
}`,
};

// ---
// Hauptfunktion
// ---
export default async function (req: Request): Promise<Response> {
  // CORS für GitHub-Pages-Frontend
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ error: "POST only" }, 405, corsHeaders);

  try {
    const body = await req.json();

    // ---
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

      // 1) Airtable-Backup (best-effort)
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

      // 2) Pipedrive-Lead anlegen
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

    // ---
    // ---
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

      // Async — Frontend muss nicht warten
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

    // ---
    // ---
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

    // ---
    //    Liefert Top-3 Treffer (Substring-Match) zum User-Auswählen — User sieht echte Org-Namen statt
    // ---
    if (body.action === 'find_property_manager') {
      const q = String(body.query || '').trim();
      if (q.length < 3) return jsonResp({ ok: true, results: [] }, 200, corsHeaders);
      const orgs = await findPipedriveOrgsByName(q, 3);
      if (!orgs.length) return jsonResp({ ok: true, results: [], source: 'db' }, 200, corsHeaders);
      // Pro Treffer: generische Email holen (parallel)
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

    // ---
    // ---
    if (body.action === 'submit_eigentuemer_cta') {
      const c = body.cta || {};
      const hvName  = String(c.hv_name  || '').trim();
      const hvEmail = String(c.hv_email || '').trim();
      const userEmail = String(c.user_email || '').trim();
      const userName  = String(c.user_name  || '').trim() || userEmail || 'Anonym';
      const checkNr   = String(c.check_nr || '').trim() || '—';
      const role      = String(c.role     || 'eigentuemer').trim();
      const savings   = Number(c.savings_total_eur || 0);

      if (!hvName) return jsonResp({ ok: false, error: 'hv_name Pflichtfeld' }, 400, corsHeaders);

      try {
        // 1) HV-Org finden ODER anlegen
        let org = await findPipedriveOrgByName(hvName);
        let orgId: number | null = org?.id || null;
        let orgCreated = false;
        if (!orgId) {
          const created = await createPipedriveOrgWithEmail({
            name: hvName,
            email: isGenericHvEmail(hvEmail) ? hvEmail : undefined,
            source: 'user_verifiziert',
          });
          if (created.ok && created.org_id) { orgId = created.org_id; orgCreated = true; }
        }

        // 2) Wenn HV-Org existiert aber Email noch leer → user-übergebene Mail nachtragen (nur generisch)
        if (orgId && !orgCreated && hvEmail && isGenericHvEmail(hvEmail)) {
          const existingMail = await getOrgGenericEmail(orgId);
          if (!existingMail) {
            // Anonyme Default-Person mit der Mail an die Org hängen
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

        // 3) User-Lead via Email finden → an Org linken
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

        // 4) HV-Lead anlegen (separater B2B-Lead)
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

    // ---
    if (body.action === 'get_defaults') {
      return jsonResp({
        prompts: DEFAULT_SYSTEM_PROMPTS,
        role_contexts: ROLE_CONTEXTS,
        model: MODEL,
      }, 200, corsHeaders);
    }

    // ---
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
        // Airtable: max 10 Records pro POST-Batch
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
    // Rolle normalisieren (Default = mieter, falls Frontend keinen Wert sendet)
    const role = ['mieter','eigentuemer','verwalter'].includes(body.role) ? body.role : 'mieter';
    // Vom Nutzer bestätigte Aufzug-Anzahl (Frontend-Pflichtfeld). Default 1.
    const aufzugCountUser = Math.max(1, Math.min(50, parseInt(String(body.aufzug_count_user || '1'), 10) || 1));
    // Optionaler User-Wert für die Wartungssumme. > 0 = User hat Wert eingetragen → Vorrang vor KI.
    const wartungBruttoUser = Math.max(0, parseFloat(String(body.wartung_brutto_user || '0').replace(',', '.')) || 0);

    // 1. Turnstile validieren (wenn konfiguriert)
    const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
    if (turnstileSecret && turnstile_token) {
      const ok = await verifyTurnstile(turnstile_token, turnstileSecret);
      if (!ok) return jsonResp({ error: "Captcha ungültig" }, 403, corsHeaders);
    }

    // 2. Consent prüfen
    if (!consent_given) return jsonResp({ error: "Einwilligung fehlt" }, 400, corsHeaders);

    // 3. Check-Type validieren + Prompt zusammenbauen (Rolle-Kontext + Default)
    const custom = await loadCustomPrompts();
    let systemPrompt = buildSystemPrompt(check_type, role, custom);
    if (!systemPrompt) return jsonResp({ error: "Unbekannter Check-Typ" }, 400, corsHeaders);

    // 3b. Bei Angebots-Checks: Preisreferenzen als Kontext anhängen, damit die KI
    // jede Angebots-Position gegen den Marktmedian aus Airtable prüfen kann.
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

    // 4. Anthropic-Call
    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_KEY") });
    const t0 = Date.now();

    const isPdf = file.mime === "application/pdf";
    const userContent: any[] = [
      {
        type: isPdf ? "document" : "image",
        source: { type: "base64", media_type: file.mime, data: file.base64 },
      },
      { type: "text", text: "Prüfe das beigefügte Dokument gemäß den Vorgaben und antworte ausschließlich mit dem geforderten JSON." },
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

    // 5. JSON parsen
    const textBlock = response.content.find((c: any) => c.type === "text");
    const rawText = textBlock?.text || "{}";
    const cleaned = rawText.replace(/^```json\s*|\s*```$/g, "").trim();
    let result: any;
    try { result = JSON.parse(cleaned); }
    catch { return jsonResp({ error: "KI-Antwort konnte nicht geparst werden", raw: rawText }, 500, corsHeaders); }

    // 6. Check-Nummer erzeugen
    const checkNr = await generateCheckNr();
    result.check_nr = checkNr;

    // 7. Lead + Vorab-Check in Airtable speichern
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

    // 8. Return — nur die Daten, die das Frontend braucht
    // savings_total_eur ist die Gesamthaus-Ersparnis (Fallback: legacy savings_estimate_eur)
    // savings_individual_eur ist die Ersparnis für die anfragende Partei
    let savingsTotal = Number(result.savings_total_eur || result.savings_estimate_eur || 0);
    const meaPool       = Number(result.mea_pool_total || 0);
    const meaEigentuemer = Number(result.mea_eigentuemer || 0);

    // SICHERHEITSNETZ A: Markt-Ersparnis IMMER selbst rechnen — der KI-Rechnung wird NICHT mehr vertraut.
    // Strategie: brutto-Wartungsbetrag erstmal aus anonymized_data lesen, sonst per Regex aus
    // dem Klartext (summary + findings) extrahieren. Dann mit Median 980 €/Anlage/Jahr vergleichen.
    if (check_type === 'nebenkosten') {
      // User-Angabe hat Vorrang vor KI-Schätzung (aus Dokument oft nicht eindeutig ableitbar)
      const aufzugCount = aufzugCountUser;
      result.aufzug_count = aufzugCount; // Im Response konsistent halten
      let aufzugBrutto = 0;
      let bruttoSource = 'unknown'; // 'user' | 'ki' | 'regex' — für Transparenz

      if (wartungBruttoUser > 0) {
        // Höchste Priorität: User hat den Wert manuell eingetragen
        aufzugBrutto = wartungBruttoUser;
        bruttoSource = 'user';
        // anonymized_data konsistent halten — User-Wert auch dort speichern
        if (!result.anonymized_data) result.anonymized_data = {};
        result.anonymized_data.betrag_aufzug_brutto = aufzugBrutto;
        console.log('[liftaro-vorabcheck] brutto vom User:', aufzugBrutto);
      } else {
        // Fallback 1: KI-extrahierter Wert aus anonymized_data
        aufzugBrutto = Number(result.anonymized_data?.betrag_aufzug_brutto || 0);
        if (aufzugBrutto >= 500) bruttoSource = 'ki';

        // Fallback 2: Regex aus Klartext, wenn KI-Wert fehlt oder verdächtig klein
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

      // Authoritative Berechnung — überschreibt IMMER die KI-Werte, wenn der Markt-Vergleich greift
      if (proAnlage > 1200) {
        // Ersparnis = exakte Differenz zwischen aktuellem Wartungspreis und Marktmedian.
        // Kein "Verhandlungsfaktor" mehr — wenn neu ausgeschrieben wird, ist genau das die
        // erreichbare Ersparnis.
        const correctTotal = Math.round((proAnlage - 980) * aufzugCount);
        const proAnlageStr = Math.round(proAnlage).toLocaleString('de-DE');
        const diffStr      = Math.round(proAnlage - 980).toLocaleString('de-DE');
        // pctSavings = exakter prozentualer Anteil (Differenz/Brutto)
        const pctSavings = aufzugBrutto > 0 ? Math.round((correctTotal / aufzugBrutto) * 100) : 0;

        // Authoritative-Override (savings + summary + finding + ampel)
        savingsTotal = correctTotal;
        result.savings_text = 'rund ' + pctSavings + ' % der bisherigen Wartungskosten durch marktgerechte Neuausschreibung';

        // Summary überschreiben, wenn KI eine falsche/keine Marktposition genannt hat.
        // Konkreten Median-Wert (980 €) NICHT erwähnen — nur generische Marktreferenz.
        const summaryHasMarketClaim = /markt|median/i.test(String(result.summary || ''));
        const summaryIsConsistent = summaryHasMarketClaim && /über|ueber|deutlich|teuer/i.test(String(result.summary || ''));
        if (!summaryIsConsistent) {
          result.summary = 'Ihre Wartung kostet ' + proAnlageStr + ' € pro Jahr je Aufzug — das ist rund ' + diffStr + ' € mehr als der übliche Marktpreis für Wartung und Notruf. Optimierungspotenzial vorhanden.';
        }
        // Falls die KI selbst die konkrete 980-Zahl in summary geschrieben hat → entfernen
        if (result.summary) {
          result.summary = String(result.summary).replace(/\bvon\s+9\s?80\s*(€|EUR)\b/gi, '').replace(/\(?\b9\s?80\s*(€|EUR)\b\)?/gi, '').replace(/\s{2,}/g, ' ').trim();
        }
        // Selbe Säuberung für savings_text
        if (result.savings_text) {
          result.savings_text = String(result.savings_text).replace(/\bvon\s+9\s?80\s*(€|EUR)\b/gi, '').replace(/\(?\b9\s?80\s*(€|EUR)\b\)?/gi, '').replace(/\s{2,}/g, ' ').trim();
        }

        // Vorhandenes Markt-Finding ENTFERNEN (KI-Mathe ist meist falsch), durch authoritatives ersetzen
        let findings = result.findings || [];
        findings = findings.filter(f => !/markt|wartung.*(zu\s+(teuer|hoch)|ueber|über)|optimierung.*?wartung/i.test((f.title||'') + ' ' + (f.description||'')));
        findings.unshift({
          severity: proAnlage > 1800 ? 'warn' : (proAnlage > 1500 ? 'amber' : 'blue'),
          title: 'Wartung teurer als üblich',
          description: 'Die Wartung kostet ' + proAnlageStr + ' € pro Jahr je Aufzug — rund ' + diffStr + ' € mehr als der übliche Marktpreis. Bei einer Neuausschreibung zu marktüblichen Konditionen sparen Sie ' + correctTotal.toLocaleString('de-DE') + ' € pro Jahr.',
          tag: 'Liftaro-Marktreferenz · aktuell ' + proAnlageStr + ' EUR/Jahr',
        });

        result.findings = findings;

        // Ampel anpassen: bei deutlich über Markt mindestens gelb
        if ((result.ampel === 'gruen' || result.ampel === 'grün') && proAnlage > 1500) {
          result.ampel = 'gelb';
        }

        console.log('[liftaro-vorabcheck] Markt-Override: brutto=' + aufzugBrutto + ', anlagen=' + aufzugCount + ', proAnlage=' + proAnlage + ', diff=' + diffStr + ', ersparnis=' + correctTotal);
      }

      // Zusatz-Hinweis für Eigentümer und Hausverwalter — IMMER (unabhängig davon, ob die Wartung
      // überteuert ist). Das Sparpotenzial dieser Auswertung deckt nur Wartung + Notruf ab.
      // Bei unterjährigen Reparaturen kann Liftaro im Einzelfall bis zu 8.000 € zusätzlich einsparen.
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

    // ---
    // Deterministisch 30–60 % vom Angebotsbetrag, basierend auf check_nr-Hash.
    if (check_type === 'angebot') {
      const angebotsumme = Number(result.anonymized_data?.angebotssumme_brutto || result.anonymized_data?.angebotssumme_netto || 0);
      const positionsLeer = !Array.isArray(result.positions_nicht_in_liste) ? 0 : result.positions_nicht_in_liste.length;
      // Wenn KI keine Ersparnis liefert, aber wir kennen die Angebotssumme: schätzen
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
        // KI hat Ersparnis berechnet, aber einzelne Positionen waren nicht in der Liste — Hinweis
        const findings = result.findings || [];
        findings.push({
          severity: 'blue',
          title: 'Positionen ohne Preislisten-Referenz',
          description: positionsLeer + ' Angebots-Position(en) konnten nicht direkt gegen die Liftaro-Preisliste verglichen werden — diese Werte sind grobe Marktschätzungen.',
          tag: 'Preisliste-Lücke',
        });
        result.findings = findings;
      }

      // Auch für Angebote: Reparatur-Hinweis bei Eigentümer/Verwalter
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

    // Sicherheitsnetz B: Wenn MEA-Werte da sind und savings_individual_eur leer,
    // rechnen wir selbst — verhindert "73 Parteien"-Fehler bei MEA-Verteilung
    let savingsIndividual = Number(result.savings_individual_eur || 0);
    if (!savingsIndividual && savingsTotal > 0 && meaPool > 0 && meaEigentuemer > 0) {
      savingsIndividual = Math.round(savingsTotal * meaEigentuemer / meaPool);
    }

    // 7b. Pipedrive-Lead anlegen — best-effort, blockiert die Response nicht.
    // Jeder Vorabcheck mit Kontaktdaten landet als Lead in der Sales-Pipeline.
    // (Steht hier UNTERHALB der Savings-Berechnung, weil savingsTotal/savingsIndividual
    // hier final feststehen — TDZ-Bug bei früherer Position behoben.)
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
        '✅ ANALYSE ABGESCHLOSSEN — Check-Nr ' + checkNr,
        '',
        'Rolle: ' + roleLabel,
        'Check-Typ: ' + checkTypeLabel,
        'Ampel: ' + ampelLabel,
        savingsTotal ? 'Geschätzte Gesamtersparnis (Haus): ' + fmt(savingsTotal) + ' €/Jahr' : 'Geschätzte Gesamtersparnis: –',
        savingsIndividual ? 'Geschätzte individuelle Ersparnis: ' + fmt(savingsIndividual) + ' €/Jahr' : '',
        'Adresse Objekt: ' + (lead.adresse || '–'),
        '',
        '— Zusammenfassung —',
        result.summary || '(keine)',
      ].filter(Boolean);
      const note = noteLines.join('\n');
      const title = '[Vorabcheck] ' + fullName + ' — ' + roleLabel + ' (' + checkNr + ')';
      // Async, fehlerresistent — upsertPipedriveLead dedupliziert per Email
      createPipedriveLead({
        name: fullName,
        email: lead.email,
        phone: lead.telefon || undefined,
        title,
        note,
      }).catch(e => console.warn('[Pipedrive] Vorabcheck failed:', e?.message || e));
    }

    // Aufzug-Positionen + Gesamtkosten aus KI-Antwort durchreichen (defensiv normalisieren)
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
    }, 200, corsHeaders);

  } catch (e: any) {
    console.error("[liftaro-vorabcheck]", e);
    return jsonResp({ error: e.message || "Server-Fehler" }, 500, corsHeaders);
  }
}

// ---
// Helpers
// ---
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
  // Fortlaufende Nummer aus Airtable (oder einfacher Zähler via val.town blob)
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

  const totalEur = Number(data.result.savings_total_eur || data.result.savings_estimate_eur || 0);
  const indivEur = Number(data.result.savings_individual_eur || 0);

  // Lead-Tabelle (mit PII)
  await fetch(`${at}/Vorabcheck-Leads`, {
    method: "POST", headers,
    body: JSON.stringify({
      fields: {
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
      },
    }),
  }).catch(e => console.warn("Lead-Save:", e.message));

  // Aufzug-Positionen + Gesamtkosten aus dem Result
  const aufzugPositionen = Array.isArray(data.result.aufzug_positionen) ? data.result.aufzug_positionen : [];
  const aufzugPositionenText = aufzugPositionen
    .map((p: any) => (p.text || '') + ': ' + (Number(p.betrag_eur || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + ' €')
    .join('\n');
  let aufzugGesamtkosten = Number(data.result.aufzug_gesamtkosten_eur || 0);
  if (!aufzugGesamtkosten && aufzugPositionen.length) {
    aufzugGesamtkosten = aufzugPositionen.reduce((s: number, p: any) => s + (Number(p.betrag_eur) || 0), 0);
  }

  // Vorab-Check-Tabelle (anonymisiert für KI-Lernen)
  await fetch(`${at}/Vorab-Checks`, {
    method: "POST", headers,
    body: JSON.stringify({
      fields: {
        check_nr: data.check_nr,
        check_type: data.check_type,
        role: data.role,
        ampel: data.result.ampel,
        summary: data.result.summary,
        savings_estimate_eur: totalEur,
        savings_total_eur: totalEur,
        savings_individual_eur: indivEur,
        aufzug_count: Number(data.result.aufzug_count || 0),
        parteien_count: Number(data.result.parteien_count || 0),
        aufzug_gesamtkosten_eur: aufzugGesamtkosten,
        aufzug_positionen_text: aufzugPositionenText,
        aufzug_positionen_json: JSON.stringify(aufzugPositionen),
        findings_json: JSON.stringify(data.result.findings || []),
        anonymized_data_json: JSON.stringify(data.result.anonymized_data || {}),
        savedAt: new Date().toISOString(),
      },
    }),
  }).catch(e => console.warn("VorabCheck-Save:", e.message));

  // Cost-Tracking
  await fetch(`${at}/API-Cost-Log`, {
    method: "POST", headers,
    body: JSON.stringify({
      fields: {
        check_nr: data.check_nr,
        endpoint: "vorabcheck",
        model: data.model,
        tokens_in: data.tokens_in,
        tokens_out: data.tokens_out,
        cost_eur: Math.round(data.cost_eur * 10000) / 10000,
        duration_ms: data.duration_ms,
        savedAt: new Date().toISOString(),
      },
    }),
  }).catch(e => console.warn("Cost-Log:", e.message));
}

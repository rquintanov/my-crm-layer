/****************************************************************
* ElevenLabs → Clientify
* - Crea SIEMPRE un contacto nuevo, añade nota y campos
* - Reparte por hash y asigna OWNER por EMAIL al CONTACTO
* - Crea el DEAL y, si no hereda, fuerza OWNER por EMAIL
* - Devuelve owners efectivos + trazas
****************************************************************/
import axios from "axios";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ───────────── Helpers de entrada ───────────── */
function isDryRun(req) {
  return (
    process.env.DRY_RUN === "true" ||
    req.query?.dryRun === "1" ||
    req.headers["x-dry-run"] === "true"
  );
}

function wrapIfFlat(raw) {
  if (!raw || typeof raw !== "object") return raw;
  if (raw.payload && raw.type && raw.intent) return raw;

  if (raw.name || raw.email || raw.phone || raw.last_name) {
    const {
      name, last_name, email, phone,
      summary, source, tags,
      destino_crucero, fecha_crucero, adultos, ninos, urgencia_compra,
      intent, type, ...rest
    } = raw;
    return {
      type  : type   || "intent_detected",
      intent: intent || "create_lead",
      payload: {
        name, last_name, email, phone, summary, source, tags,
        destino_crucero, fecha_crucero, adultos, ninos, urgencia_compra
      },
      ...rest
    };
  }
  return raw;
}

function splitName(full = "", last = "") {
  if (last) return { first_name: String(full).trim(), last_name: String(last).trim() };
  const parts = String(full).trim().split(/\s+/);
  return parts.length > 1
    ? { first_name: parts[0], last_name: parts.slice(1).join(" ") }
    : { first_name: parts[0] || "", last_name: "" };
}

const normalizeInt = (v) => (v === undefined || v === null || v === "" ? undefined :
  (n => Number.isFinite(n) ? n : undefined)(Number(String(v).replace(/[^\d.-]/g, ""))));
const cleanDate = (v) => v ? String(v).trim() : undefined;

/* ───────────── Config Clientify ───────────── */
const CLIENTIFY_BASE = process.env.CLIENTIFY_BASE_URL?.trim() || "https://api.clientify.net/v1";
const TOKEN = (process.env.CLIENTIFY_TOKEN || "").replace(/[\r\n'"]/g, "").trim();

const clientify = axios.create({
  baseURL: CLIENTIFY_BASE,
  headers: { Authorization: `Token ${TOKEN}`, Accept: "application/json" },
  timeout: 15000,
  validateStatus: () => true
});

/* ───────────── Campos personalizados (opcionales) ───────────── */
const CF_IDS = {
  destino : process.env.CLIENTIFY_CF_DESTINO_ID  || "",
  fecha   : process.env.CLIENTIFY_CF_FECHA_ID    || "",
  adultos : process.env.CLIENTIFY_CF_ADULTOS_ID  || "",
  ninos   : process.env.CLIENTIFY_CF_NINOS_ID    || "",
  urgencia: process.env.CLIENTIFY_CF_URGENCIA_ID || ""
};

/* ───────────── API helpers ───────────── */
async function createContact({ first_name, last_name, email, phone, source, tags = [], summary }) {
  const safeTags =
    Array.isArray(tags)
      ? tags
      : typeof tags === "string"
          ? tags.split(",").map(t => t.trim()).filter(Boolean)
          : [];
  const r = await clientify.post("/contacts/", {
    first_name, last_name, email, phone,
    contact_source: source || "AI Agent",
    tags: safeTags, summary: summary || ""
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`createContact → ${r.status} ${JSON.stringify(r.data)}`);
}

async function addNote(contactId, text) {
  if (!text) return;
  await clientify.post(`/contacts/${contactId}/note/`, { name: "Datos del Agente", comment: text });
}

async function updateCustomFields(contactId, map) {
  const entries = Object.entries(map)
    .map(([k, v]) => ({ id: CF_IDS[k], value: v }))
    .filter(e => e.id && e.value !== undefined && e.value !== null && e.value !== "");
  if (!entries.length) return;
  const payload = { custom_fields_values: entries.map(e => ({ id: e.id, value: String(e.value) })) };
  await clientify.patch(`/contacts/${contactId}/`, payload);
}

async function createDeal({ contactId, name, amount = 0, stageId, fecha }) {
  const contactUrl = `${CLIENTIFY_BASE.replace(/\/$/, "")}/contacts/${contactId}/`;
  const r = await clientify.post("/deals/", {
    name, contact: contactUrl, stage: stageId, amount, expected_close_date: fecha || null
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`createDeal → ${r.status} ${JSON.stringify(r.data)}`);
}

/* Leer owners (id + email + name si vienen) */
function extractOwner(obj) {
  if (!obj || typeof obj !== "object") return { id: null, email: null, name: null };
  if (typeof obj.owner_id === "number") return { id: String(obj.owner_id), email: obj.owner || null, name: obj.owner_name || null };
  if (typeof obj.owner_id === "string" && /^\d+$/.test(obj.owner_id)) return { id: obj.owner_id, email: obj.owner || null, name: obj.owner_name || null };
  const own = obj.owner ?? obj.user ?? obj.assigned_to ?? null;
  if (typeof own === "string") {
    const m = own.match(/\/users\/(\d+)\/?$/);
    if (m) return { id: m[1], email: null, name: obj.owner_name || null };
    if (/^\d+$/.test(own)) return { id: own, email: null, name: obj.owner_name || null };
    if (own.includes("@")) return { id: null, email: own, name: obj.owner_name || null };
  }
  if (own && typeof own === "object") {
    if (own.id) return { id: String(own.id), email: own.email || null, name: own.name || obj.owner_name || null };
    if (own.url && typeof own.url === "string") {
      const m2 = own.url.match(/\/users\/(\d+)\/?$/);
      if (m2) return { id: m2[1], email: own.email || null, name: own.name || obj.owner_name || null };
    }
  }
  return { id: null, email: null, name: obj.owner_name || null };
}
async function readContactOwner(contactId) {
  const r = await clientify.get(`/contacts/${contactId}/`);
  return (r.status >= 200 && r.status < 300) ? { ...extractOwner(r.data||{}), raw: r.data } : { id:null, email:null, name:null, raw:r.data };
}
async function readDealOwner(dealId) {
  const r = await clientify.get(`/deals/${dealId}/`);
  return (r.status >= 200 && r.status < 300) ? { ...extractOwner(r.data||{}), raw: r.data } : { id:null, email:null, name:null, raw:r.data };
}

/* PATCH owner por EMAIL (lo que tu cuenta acepta) y verifica por GET */
async function assignOwnerByEmail(kind, id, email) {
  const tried = [];
  for (const key of ["owner","user"]) {
    try {
      const r = await clientify.patch(`/${kind}/${id}/`, { [key]: email });
      tried.push({ key, valueType: "email", status: r.status, data: r.data?.detail || null });
      if (r.status >= 200 && r.status < 300) {
        await sleep(250);
        const read = kind === "contacts" ? await readContactOwner(id) : await readDealOwner(id);
        if (read.email === email) return { ok: true, tried, winner: { key, valueType: "email" } };
      }
    } catch (e) {
      tried.push({ key, valueType: "email", status: e.response?.status || null, data: e.response?.data || e.message });
    }
  }
  return { ok: false, tried, winner: null };
}

/* ───────────── Reparto (por EMAIL) ───────────── */
function getAgentEmails() {
  const raw = (process.env.CLIENTIFY_AGENT_EMAILS || "").trim();
  return raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
}
function pickEmailByHash(contactId, emails) {
  if (!emails.length) return null;
  const n = Number(String(contactId).replace(/[^\d]/g, "")) || 0;
  return emails[n % emails.length];
}

/* ───────────── Validaciones ───────────── */
function validateEnvelope(b) {
  if (!b || typeof b !== "object")            return "Body vacío o no es JSON";
  if (b.type !== "intent_detected")           return "type debe ser 'intent_detected'";
  if (!b.intent)                              return "Falta 'intent'";
  if (!b.payload || typeof b.payload !== "object") return "Falta 'payload'";
  return null;
}
function validateLeadPayload(p) {
  if (!p?.name && !p?.first_name) return "Falta 'name' o 'first_name'";
  if (!p.email && !p.phone)       return "Debes enviar 'email' o 'phone'";
  return null;
}

/* ───────────── Handler ───────────── */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    if (!TOKEN) return res.status(500).json({ error: "CLIENTIFY_TOKEN no definido" });

    // Firma simple (opcional)
    if (process.env.ELEVENLABS_SECRET &&
        req.headers["x-elevenlabs-secret"] !== process.env.ELEVENLABS_SECRET) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const envelope = wrapIfFlat(req.body);
    if (isDryRun(req)) return res.status(200).json({ ok: true, mode: "dry-run", received: envelope });

    const envErr = validateEnvelope(envelope);
    if (envErr) return res.status(400).json({ error: envErr });

    const { intent, payload } = envelope;
    if (intent !== "create_lead") return res.status(200).json({ ok: true, message: `Intent '${intent}' no implementado` });

    const pErr = validateLeadPayload(payload);
    if (pErr) return res.status(400).json({ error: pErr });

    /* ─── Crear contacto ─── */
    const {
      name, last_name, email, phone, summary, source, tags,
      destino_crucero, fecha_crucero, adultos, ninos, urgencia_compra
    } = payload;

    const { first_name, last_name: ln } = splitName(name, last_name);
    const contact = await createContact({ first_name, last_name: ln, email, phone, source, tags, summary });

    const nota =
      `Datos del lead:\n` +
      (destino_crucero ? `- Destino crucero: ${destino_crucero}\n` : "") +
      (fecha_crucero   ? `- Fecha crucero: ${fecha_crucero}\n`   : "") +
      (normalizeInt(adultos) ? `- Adultos: ${normalizeInt(adultos)}\n` : "") +
      (normalizeInt(ninos)   ? `- Niños: ${normalizeInt(ninos)}\n`     : "") +
      (urgencia_compra ? `- Urgencia de compra: ${urgencia_compra}\n` : "") +
      (summary ? `- Resumen: ${summary}\n` : "");
    await addNote(contact.id, nota);

    await updateCustomFields(contact.id, {
      destino  : destino_crucero,
      fecha    : cleanDate(fecha_crucero),
      adultos  : normalizeInt(adultos),
      ninos    : normalizeInt(ninos),
      urgencia : urgencia_compra
    });

    /* ─── Reparto por EMAIL ─── */
    const emails = getAgentEmails();
    const intendedOwnerEmail = pickEmailByHash(contact.id, emails);
    let chosenOwnerEmail = intendedOwnerEmail || null;

    // Si el email elegido está vacío, probamos el siguiente de la lista
    if (!chosenOwnerEmail && emails.length) chosenOwnerEmail = emails[0];

    /* ─── Asignar owner al CONTACTO por EMAIL ─── */
    let contactAssign = null, contactOwnerAfter = null;
    if (chosenOwnerEmail) {
      contactAssign = await assignOwnerByEmail("contacts", contact.id, chosenOwnerEmail);
      await sleep(200);
      contactOwnerAfter = await readContactOwner(contact.id);
    } else {
      contactOwnerAfter = await readContactOwner(contact.id);
    }

    /* ─── Crear DEAL ─── */
    const stageId = process.env.CLIENTIFY_DEAL_STAGE_ID;
    let deal = null, dealOwnerAfter = null, dealPatch = null;

    if (stageId) {
      const amount = process.env.DEFAULT_DEAL_AMOUNT ? Number(process.env.DEFAULT_DEAL_AMOUNT) : 0;
      const dealName = `Crucero: ${destino_crucero || "Destino"} · ${cleanDate(fecha_crucero) || "Fecha"}`;

      deal = await createDeal({ contactId: contact.id, name: dealName, amount, stageId, fecha: cleanDate(fecha_crucero) });

      await sleep(250);
      dealOwnerAfter = await readDealOwner(deal.id);

      // Si no heredó o heredó otro, forzamos por EMAIL
      if (chosenOwnerEmail && dealOwnerAfter.email !== chosenOwnerEmail) {
        dealPatch = await assignOwnerByEmail("deals", deal.id, chosenOwnerEmail);
        await sleep(250);
        dealOwnerAfter = await readDealOwner(deal.id);
      }
    } else {
      console.warn("CLIENTIFY_DEAL_STAGE_ID no definido → no se crea deal");
    }

    /* ─── Respuesta ───────────── */
    return res.status(200).json({
      ok: true,
      base: CLIENTIFY_BASE,
      contactId: contact.id,
      dealId: deal?.id || null,

      // Propietarios efectivos (según Clientify)
      contactOwnerId: contactOwnerAfter?.id || null,
      contactOwnerEmail: contactOwnerAfter?.email || null,
      contactOwnerName: contactOwnerAfter?.name || null,

      dealOwnerId: dealOwnerAfter?.id || null,          // puede venir null en deals
      dealOwnerEmail: dealOwnerAfter?.email || null,    // fiable en tu cuenta
      dealOwnerName: dealOwnerAfter?.name || null,

      // Reparto
      intendedOwnerEmail,
      chosenOwnerEmail,

      // Trazas
      debug: {
        contactAssign,
        contactOwnerAfter,
        dealPatch,
        dealOwnerAfter
      }
    });

  } catch (e) {
    console.error("ERROR", e.response?.status, e.response?.config?.url, e.response?.data || e.message);
    return res.status(500).json({
      error: "Clientify integration failed",
      status: e.response?.status,
      url   : e.response?.config?.url,
      details: e.response?.data || e.message
    });
  }
}



/****************************************************************
* ElevenLabs → Clientify
* - Crea SIEMPRE un contacto nuevo, añade nota y campos
* - Asigna propietario al CONTACTO
* - Crea Deal (intentando ya con owner) y refuerza por PATCH si hace falta
* - Verifica por GET el owner final en contacto y deal y lo devuelve
****************************************************************/
import axios from "axios";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ───────────── Utils entrada ───────────── */
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

/* ───────────── Helpers Contact ───────────── */
async function createContact({ first_name, last_name, email, phone, source, tags = [], summary }) {
  const safeTags =
    Array.isArray(tags)
      ? tags
      : typeof tags === "string"
          ? tags.split(",").map(t => t.trim()).filter(Boolean)
          : [];

  const body = {
    first_name,
    last_name,
    email,
    phone,
    contact_source: source || "AI Agent",
    tags: safeTags,
    summary: summary || ""
  };

  const r = await clientify.post("/contacts/", body);
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`createContact → ${r.status} ${JSON.stringify(r.data)}`);
}

/* Nota */
async function addNote(contactId, text) {
  if (!text) return;
  await clientify.post(`/contacts/${contactId}/note/`, {
    name: "Datos del Agente",
    comment: text
  });
}

/* Campos personalizados */
async function updateCustomFields(contactId, map) {
  const entries = Object.entries(map)
    .map(([k, v]) => ({ id: CF_IDS[k], value: v }))
    .filter(e => e.id && e.value !== undefined && e.value !== null && e.value !== "");
  if (!entries.length) return;

  const payload = { custom_fields_values: entries.map(e => ({ id: e.id, value: String(e.value) })) };
  await clientify.patch(`/contacts/${contactId}/`, payload);
}

/* ───────────── Reparto de agentes ───────────── */
function getAgentIds() {
  const raw = (process.env.CLIENTIFY_AGENT_USER_IDS || "").trim();
  return raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
}
function pickByHash(contactId, agentIds) {
  if (!agentIds.length) return undefined;
  const n = Number(String(contactId).replace(/[^\d]/g, "")) || 0;
  return agentIds[n % agentIds.length];
}

/* ───────────── Deal & Owner helpers ───────────── */
// Crea deal; si admite owner en POST, lo incluimos
async function createDealWithOptionalOwner({ contactId, name, amount = 0, stageId, fecha, ownerUserId }) {
  const base = CLIENTIFY_BASE.replace(/\/$/, "");
  const contactUrl = `${base}/contacts/${contactId}/`;
  const ownerUrl   = ownerUserId ? `${base}/users/${ownerUserId}/` : undefined;

  const body = {
    name,
    contact: contactUrl,
    stage  : stageId,
    amount,
    expected_close_date: fecha || null,
    ...(ownerUrl ? { owner: ownerUrl } : {})
  };

  const r = await clientify.post("/deals/", body);
  if (r.status >= 200 && r.status < 300) return r.data;

  // Reintenta sin owner si el POST con owner no es aceptado
  if ([400,403,404,409,422].includes(r.status) && ownerUrl) {
    const r2 = await clientify.post("/deals/", {
      name, contact: contactUrl, stage: stageId, amount, expected_close_date: fecha || null
    });
    if (r2.status >= 200 && r2.status < 300) return r2.data;
  }
  throw new Error(`createDealWithOptionalOwner → ${r.status} ${JSON.stringify(r.data)}`);
}

// PATCH deal (owner/user + url/id)
async function assignOwnerToDeal(dealId, ownerUserId) {
  const base = CLIENTIFY_BASE.replace(/\/$/, "");
  const ownerUrl = `${base}/users/${ownerUserId}/`;
  const attempts = [
    { key: "owner", value: ownerUrl, valueType: "url" },
    { key: "user",  value: ownerUrl, valueType: "url" },
    { key: "owner", value: Number(ownerUserId), valueType: "id" },
    { key: "user",  value: Number(ownerUserId), valueType: "id" }
  ];
  const tried = [];
  for (const a of attempts) {
    try {
      const r = await clientify.patch(`/deals/${dealId}/`, { [a.key]: a.value });
      tried.push({ key: a.key, valueType: a.valueType, status: r.status, data: r.data?.detail || null });
      if (r.status >= 200 && r.status < 300) return { ok: true, tried, winner: { key: a.key, valueType: a.valueType } };
    } catch (e) {
      tried.push({ key: a.key, valueType: a.valueType, status: e.response?.status || null, data: e.response?.data || e.message });
    }
  }
  return { ok: false, tried, winner: null };
}

// PATCH contacto (owner/user + url/id)
async function assignOwnerToContact(contactId, ownerUserId) {
  const base = CLIENTIFY_BASE.replace(/\/$/, "");
  const ownerUrl = `${base}/users/${ownerUserId}/`;
  const attempts = [
    { key: "owner", value: ownerUrl, valueType: "url" },
    { key: "user",  value: ownerUrl, valueType: "url" },
    { key: "owner", value: Number(ownerUserId), valueType: "id" },
    { key: "user",  value: Number(ownerUserId), valueType: "id" }
  ];
  const tried = [];
  for (const a of attempts) {
    try {
      const r = await clientify.patch(`/contacts/${contactId}/`, { [a.key]: a.value });
      tried.push({ key: a.key, valueType: a.valueType, status: r.status, data: r.data?.detail || null });
      if (r.status >= 200 && r.status < 300) return { ok: true, tried, winner: { key: a.key, valueType: a.valueType } };
    } catch (e) {
      tried.push({ key: a.key, valueType: a.valueType, status: e.response?.status || null, data: e.response?.data || e.message });
    }
  }
  return { ok: false, tried, winner: null };
}

// Lectores owner (parsean varias formas posibles)
function extractOwnerIdFromObj(obj) {
  // intenta "owner", "user", "assigned_to", "owner_id", "user_id", objeto con url o id, o string URL
  const cand = obj?.owner ?? obj?.user ?? obj?.assigned_to ?? obj?.owner_id ?? obj?.user_id ?? null;
  if (typeof cand === "number") return String(cand);
  if (typeof cand === "string") {
    const m = cand.match(/\/users\/(\d+)\/?$/);
    return m ? m[1] : ( /^\d+$/.test(cand) ? cand : null );
  }
  if (cand && typeof cand === "object") {
    if (typeof cand.id === "number" || typeof cand.id === "string") return String(cand.id);
    if (cand.url && typeof cand.url === "string") {
      const m2 = cand.url.match(/\/users\/(\d+)\/?$/);
      if (m2) return m2[1];
    }
  }
  return null;
}
async function readDealOwner(dealId) {
  const r = await clientify.get(`/deals/${dealId}/`);
  const ownerId = (r.status >= 200 && r.status < 300) ? extractOwnerIdFromObj(r.data || {}) : null;
  return { ownerId, rawKeys: Object.keys(r.data || {}) };
}
async function readContactOwner(contactId) {
  const r = await clientify.get(`/contacts/${contactId}/`);
  const ownerId = (r.status >= 200 && r.status < 300) ? extractOwnerIdFromObj(r.data || {}) : null;
  return { ownerId, rawKeys: Object.keys(r.data || {}) };
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
    if (isDryRun(req)) {
      return res.status(200).json({ ok: true, mode: "dry-run", received: envelope });
    }

    const envErr = validateEnvelope(envelope);
    if (envErr) return res.status(400).json({ error: envErr });

    const { intent, payload } = envelope;
    if (intent !== "create_lead") {
      return res.status(200).json({ ok: true, message: `Intent '${intent}' no implementado` });
    }

    const pErr = validateLeadPayload(payload);
    if (pErr) return res.status(400).json({ error: pErr });

    /* ─── Crear contacto ─── */
    const {
      name, last_name, email, phone, summary, source, tags,
      destino_crucero, fecha_crucero, adultos, ninos, urgencia_compra
    } = payload;

    const { first_name, last_name: ln } = splitName(name, last_name);

    const contact = await createContact({
      first_name,
      last_name: ln,
      email,
      phone,
      source,
      tags,
      summary
    });

    /* Nota y CF */
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

    /* ─── Reparto: elegimos owner antes de todo ─── */
    const agentIds = getAgentIds();
    const intendedOwnerId = agentIds.length ? pickByHash(contact.id, agentIds) : null;

    /* ─── Asignar owner al CONTACTO primero ─── */
    let contactAssign = null, contactOwnerAfter = null;
    if (intendedOwnerId) {
      contactAssign = await assignOwnerToContact(contact.id, intendedOwnerId);
      await sleep(250);
      contactOwnerAfter = await readContactOwner(contact.id);
    }

    /* ─── Crear DEAL e intentar owner en POST ─── */
    const stageId = process.env.CLIENTIFY_DEAL_STAGE_ID;
    let deal = null, dealOwnerAfter = null, patchAfterPost = null;

    if (stageId) {
      const amount = process.env.DEFAULT_DEAL_AMOUNT ? Number(process.env.DEFAULT_DEAL_AMOUNT) : 0;
      const dealName = `Crucero: ${destino_crucero || "Destino"} · ${cleanDate(fecha_crucero) || "Fecha"}`;

      deal = await createDealWithOptionalOwner({
        contactId: contact.id,
        name: dealName,
        amount,
        stageId,
        fecha: cleanDate(fecha_crucero),
        ownerUserId: intendedOwnerId || undefined
      });

      await sleep(300);
      dealOwnerAfter = await readDealOwner(deal.id);

      if (intendedOwnerId && (!dealOwnerAfter.ownerId || dealOwnerAfter.ownerId !== String(intendedOwnerId))) {
        patchAfterPost = await assignOwnerToDeal(deal.id, intendedOwnerId);
        await sleep(300);
        dealOwnerAfter = await readDealOwner(deal.id);
      }
    } else {
      console.warn("CLIENTIFY_DEAL_STAGE_ID no definido → no se crea deal");
    }

    /* ─── Respuesta ─── */
    return res.status(200).json({
      ok: true,
      base: CLIENTIFY_BASE,
      contactId: contact.id,
      dealId: deal?.id || null,

      // RESULTADO EFECTIVO (lo que realmente quedó)
      contactOwnerId: contactOwnerAfter?.ownerId || null,
      dealOwnerId: dealOwnerAfter?.ownerId || null,

      // info del asignado previsto (hash)
      intendedOwnerId,

      // trazas para depurar automatizaciones
      debug: {
        contactAssign,
        contactOwnerAfter,
        dealReadKeys: dealOwnerAfter?.rawKeys || null,
        dealPatch: patchAfterPost || null
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


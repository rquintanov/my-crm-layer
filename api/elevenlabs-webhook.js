/****************************************************************
* ElevenLabs → Clientify
* - Crea SIEMPRE un contacto nuevo, añade nota y campos
* - Asigna propietario al CONTACTO (verificado)
* - Crea Deal SIN owner (hereda del contacto) y, si hace falta, PATCH (verificado)
* - Responde con los owners efectivos y trazas de depuración
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

async function addNote(contactId, text) {
  if (!text) return;
  await clientify.post(`/contacts/${contactId}/note/`, {
    name: "Datos del Agente",
    comment: text
  });
}

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

/* ───────────── Owner helpers ───────────── */

// Comprueba que el usuario existe
async function userExists(userId) {
  try {
    const r = await clientify.get(`/users/${userId}/`);
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// Extrae owner id de un objeto devuelto por la API
function extractOwnerIdFromObj(obj) {
  const cand = obj?.owner ?? obj?.user ?? obj?.assigned_to ?? obj?.owner_id ?? obj?.user_id ?? null;
  if (typeof cand === "number") return String(cand);
  if (typeof cand === "string") {
    const m = cand.match(/\/users\/(\d+)\/?$/);
    return m ? m[1] : (/^\d+$/.test(cand) ? cand : null);
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

async function readContactOwner(contactId) {
  const r = await clientify.get(`/contacts/${contactId}/`);
  return { ownerId: (r.status>=200 && r.status<300) ? extractOwnerIdFromObj(r.data||{}) : null, raw: r.data };
}
async function readDealOwner(dealId) {
  const r = await clientify.get(`/deals/${dealId}/`);
  return { ownerId: (r.status>=200 && r.status<300) ? extractOwnerIdFromObj(r.data||{}) : null, raw: r.data };
}

// PATCH genérico: prueba varias claves/formatos y verifica por GET
async function assignOwnerVerified({ kind, id, targetOwnerId, readFn }) {
  const base = CLIENTIFY_BASE.replace(/\/$/, "");
  const ownerUrl = `${base}/users/${targetOwnerId}/`;

  // Orden pensado para Clientify: primero owner_id numérico
  const attempts = [
    { key: "owner_id", value: Number(targetOwnerId), valueType: "id" },
    { key: "owner",    value: Number(targetOwnerId), valueType: "id" },
    { key: "user_id",  value: Number(targetOwnerId), valueType: "id" },
    { key: "user",     value: Number(targetOwnerId), valueType: "id" },
    { key: "owner",    value: ownerUrl,              valueType: "url" },
    { key: "user",     value: ownerUrl,              valueType: "url" }
  ];

  const tried = [];
  for (const a of attempts) {
    try {
      const r = await clientify.patch(`/${kind}/${id}/`, { [a.key]: a.value });
      tried.push({ key: a.key, valueType: a.valueType, status: r.status, data: r.data?.detail || null });
      // tras cualquier 2xx, verificamos por GET; si no queda, seguimos
      if (r.status >= 200 && r.status < 300) {
        await sleep(250);
        const read = await readFn(id);
        if (read.ownerId === String(targetOwnerId)) {
          return { ok: true, tried, winner: { key: a.key, valueType: a.valueType } };
        }
      }
    } catch (e) {
      tried.push({ key: a.key, valueType: a.valueType, status: e.response?.status || null, data: e.response?.data || e.message });
    }
  }
  return { ok: false, tried, winner: null };
}

/* ───────────── Deal helpers ───────────── */

// Crea el deal SIN owner; la herencia del contacto evita reglas que pisen el owner
async function createDealNoOwner({ contactId, name, amount = 0, stageId, fecha }) {
  const contactUrl = `${CLIENTIFY_BASE.replace(/\/$/, "")}/contacts/${contactId}/`;
  const body = { name, contact: contactUrl, stage: stageId, amount, expected_close_date: fecha || null };
  const r = await clientify.post("/deals/", body);
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`createDealNoOwner → ${r.status} ${JSON.stringify(r.data)}`);
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

    /* ─── Reparto ─── */
    const agentIds = getAgentIds();
    const intendedOwnerId = agentIds.length ? pickByHash(contact.id, agentIds) : null;

    // Valida que el usuario exista; si no, gira al siguiente
    let chosenOwner = intendedOwnerId;
    if (chosenOwner) {
      let idx = agentIds.indexOf(String(chosenOwner));
      let loops = 0;
      while (loops < agentIds.length && !(await userExists(chosenOwner))) {
        idx = (idx + 1) % agentIds.length;
        chosenOwner = agentIds[idx];
        loops++;
      }
      if (loops >= agentIds.length) chosenOwner = null; // ninguno válido
    }

    /* ─── Asignar owner al CONTACTO (verificado) ─── */
    let contactAssign = null, contactOwner = null;
    if (chosenOwner) {
      contactAssign = await assignOwnerVerified({
        kind: "contacts",
        id: contact.id,
        targetOwnerId: chosenOwner,
        readFn: readContactOwner
      });
      await sleep(250);
      contactOwner = await readContactOwner(contact.id);
    } else {
      contactOwner = await readContactOwner(contact.id);
    }

    /* ─── Crear DEAL SIN owner (herencia) ─── */
    const stageId = process.env.CLIENTIFY_DEAL_STAGE_ID;
    let deal = null, dealOwner = null, dealPatch = null;

    if (stageId) {
      const amount = process.env.DEFAULT_DEAL_AMOUNT ? Number(process.env.DEFAULT_DEAL_AMOUNT) : 0;
      const dealName = `Crucero: ${destino_crucero || "Destino"} · ${cleanDate(fecha_crucero) || "Fecha"}`;

      deal = await createDealNoOwner({
        contactId: contact.id,
        name: dealName,
        amount,
        stageId,
        fecha: cleanDate(fecha_crucero)
      });

      await sleep(300);
      dealOwner = await readDealOwner(deal.id);

      // Si no heredó o heredó otro, reforzamos con PATCH verificado
      if (chosenOwner && dealOwner.ownerId !== String(chosenOwner)) {
        dealPatch = await assignOwnerVerified({
          kind: "deals",
          id: deal.id,
          targetOwnerId: chosenOwner,
          readFn: readDealOwner
        });
        await sleep(300);
        dealOwner = await readDealOwner(deal.id);
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

      // Propietarios efectivos
      contactOwnerId: contactOwner?.ownerId || null,
      dealOwnerId: dealOwner?.ownerId || null,

      // Reparto previsto y elegido
      intendedOwnerId: intendedOwnerId || null,
      chosenOwnerId: chosenOwner || null,

      // Trazas útiles
      debug: {
        contactAssign,
        contactOwnerAfter: contactOwner,
        dealPatch: dealPatch,
        dealOwnerAfter: dealOwner
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


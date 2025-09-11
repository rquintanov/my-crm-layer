/****************************************************************
*  ElevenLabs → Clientify
*  Crea SIEMPRE un contacto nuevo, añade nota y campos
*  personalizados, y crea un Deal asociado en el stage indicado.
*  ➕ Reparte el deal entre agentes (owner) y lo devuelve en la respuesta.
****************************************************************/
import axios from "axios";

/* ───────────── Utilidades generales ───────────── */
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

/* ───────────── IDs de campos personalizados (opcionales) ───────────── */
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

/* ───────────── Nota ───────────── */
async function addNote(contactId, text) {
  if (!text) return;
  await clientify.post(`/contacts/${contactId}/note/`, {
    name: "Datos del Agente",
    comment: text
  });
}

/* ───────────── Campos personalizados ───────────── */
async function updateCustomFields(contactId, map) {
  const entries = Object.entries(map)
    .map(([k, v]) => ({ id: CF_IDS[k], value: v }))
    .filter(e => e.id && e.value !== undefined && e.value !== null && e.value !== "");

  if (!entries.length) return;

  const payload = { custom_fields_values: entries.map(e => ({ id: e.id, value: String(e.value) })) };
  await clientify.patch(`/contacts/${contactId}/`, payload);
}

/* ───────────── Deal helper (creación sin owner) ─────────────
   Creamos siempre el deal primero; luego asignamos el owner por PATCH.
   Esto funciona igual en todas las cuentas y evita incompatibilidades.
---------------------------------------------------------------- */
async function createDeal({ contactId, name, amount = 0, stageId, fecha }) {
  const contactUrl = `${CLIENTIFY_BASE.replace(/\/$/, "")}/contacts/${contactId}/`;

  const body = {
    name,
    contact: contactUrl,  // Clientify quiere la URL del contacto
    stage  : stageId,
    amount ,
    expected_close_date: fecha || null
  };

  const r = await clientify.post("/deals/", body);
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`createDeal → ${r.status} ${JSON.stringify(r.data)}`);
}

/* ───────────── Asignación de owner (por PATCH) ───────────── */
async function assignOwnerToDeal(dealId, ownerUserId) {
  const ownerUrl = `${CLIENTIFY_BASE.replace(/\/$/, "")}/users/${ownerUserId}/`;
  const r = await clientify.patch(`/deals/${dealId}/`, { owner: ownerUrl });
  if (r.status >= 200 && r.status < 300) return true;

  // Si el user no existe o no es válido, devolvemos false para probar el siguiente
  if (r.status === 400 || r.status === 404) return false;

  // Cualquier otro error lo propagamos
  throw new Error(`assignOwnerToDeal → ${r.status} ${JSON.stringify(r.data)}`);
}

/* ───────────── Reparto de agentes ─────────────
   Estrategia por defecto: hash determinista (idempotente)
   owner = agentIds[ contactId % agentIds.length ]
---------------------------------------------------------------- */
function getAgentIds() {
  const raw = (process.env.CLIENTIFY_AGENT_USER_IDS || "").trim();
  return raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
}

function pickByHash(contactId, agentIds) {
  if (!agentIds.length) return undefined;
  const n = Number(String(contactId).replace(/[^\d]/g, "")) || 0;
  return agentIds[n % agentIds.length];
}

/* Devuelve una lista de candidatos en orden de prioridad:
   empieza por el calculado por hash y sigue rotando por el resto.
*/
function candidatesFrom(contactId, agentIds) {
  if (!agentIds.length) return [];
  const start = Number(String(contactId).replace(/[^\d]/g, "")) % agentIds.length;
  return [...agentIds.slice(start), ...agentIds.slice(0, start)];
}

async function resolveOwnerCandidate(contactId) {
  const agentIds = getAgentIds();
  const strategy = (process.env.ASSIGNMENT_STRATEGY || "hash").toLowerCase();
  if (strategy === "hash") return { chosen: pickByHash(contactId, agentIds), list: candidatesFrom(contactId, agentIds) };
  // Futuras estrategias: rr, weighted, rules, load...
  return { chosen: pickByHash(contactId, agentIds), list: candidatesFrom(contactId, agentIds) };
}

/* (Opcional) Nombre del usuario para la respuesta. No hace fallar si algo va mal. */
async function getUserDisplay(userId) {
  try {
    const r = await clientify.get(`/users/${userId}/`);
    if (r.status >= 200 && r.status < 300) {
      const u = r.data || {};
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.name || null;
      const email = u.email || null;
      return { name, email, url: `${CLIENTIFY_BASE.replace(/\/$/, "")}/users/${userId}/` };
    }
  } catch (_e) { /* noop */ }
  return { name: null, email: null, url: `${CLIENTIFY_BASE.replace(/\/$/, "")}/users/${userId}/` };
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

    /* ─── Nota ─── */
    const nota =
      `Datos del lead:\n` +
      (destino_crucero ? `- Destino crucero: ${destino_crucero}\n` : "") +
      (fecha_crucero   ? `- Fecha crucero: ${fecha_crucero}\n`   : "") +
      (normalizeInt(adultos) ? `- Adultos: ${normalizeInt(adultos)}\n` : "") +
      (normalizeInt(ninos)   ? `- Niños: ${normalizeInt(ninos)}\n`     : "") +
      (urgencia_compra ? `- Urgencia de compra: ${urgencia_compra}\n` : "") +
      (summary ? `- Resumen: ${summary}\n` : "");

    await addNote(contact.id, nota);

    /* ─── Campos personalizados ─── */
    await updateCustomFields(contact.id, {
      destino  : destino_crucero,
      fecha    : cleanDate(fecha_crucero),
      adultos  : normalizeInt(adultos),
      ninos    : normalizeInt(ninos),
      urgencia : urgencia_compra
    });

    /* ─── Deal ─── */
    const stageId = process.env.CLIENTIFY_DEAL_STAGE_ID;
    let assignedOwnerId = null;
    let assignedOwner = null;
    let deal = null;

    if (stageId) {
      const amount = process.env.DEFAULT_DEAL_AMOUNT
        ? Number(process.env.DEFAULT_DEAL_AMOUNT) : 0;
      const dealName = `Crucero: ${destino_crucero || "Destino"} · ${cleanDate(fecha_crucero) || "Fecha"}`;

      // ① Primero creamos el deal (sin owner para máxima compatibilidad)
      deal = await createDeal({
        contactId: contact.id,
        name: dealName,
        amount,
        stageId,
        fecha: cleanDate(fecha_crucero)
      });

      // ② Calculamos candidatos y vamos probando hasta asignar uno válido
      const { list: candidates } = await resolveOwnerCandidate(contact.id);
      for (const userId of candidates) {
        try {
          const ok = await assignOwnerToDeal(deal.id, userId);
          if (ok) {
            assignedOwnerId = userId;
            assignedOwner = await getUserDisplay(userId); // nombre/email si está disponible
            break;
          }
        } catch (e) {
          // Errores no "owner inválido": registra y corta (evita bucle)
          console.error("assignOwnerToDeal ERROR", e.message);
          break;
        }
      }

      console.log("✅ deal", deal.id, "→ owner", assignedOwnerId || "(sin owner)");
    } else {
      console.warn("CLIENTIFY_DEAL_STAGE_ID no definido → no se crea deal");
    }

    /* ─── Respuesta ─── */
    return res.status(200).json({
      ok: true,
      base: CLIENTIFY_BASE,
      contactId: contact.id,
      dealId: deal?.id || null,
      assignedOwnerId,
      assignedOwnerUrl: assignedOwnerId
        ? `${CLIENTIFY_BASE.replace(/\/$/, "")}/users/${assignedOwnerId}/`
        : null,
      assignedOwnerName: assignedOwner?.name || null,
      assignedOwnerEmail: assignedOwner?.email || null
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

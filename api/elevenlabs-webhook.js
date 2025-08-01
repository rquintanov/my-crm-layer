// api/elevenlabs-webhook.js
// ElevenLabs → Clientify (api.clientify.net/v1)
// Guarda contacto, añade nota con datos de crucero y (opcional) actualiza campos personalizados.

import axios from "axios";

// ── Utilidades generales ─────────────────────────────────────
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
  // Formato plano -> lo envolvemos
  if (raw.name || raw.email || raw.phone || raw.last_name) {
    const {
      name, last_name, email, phone,
      summary, source, tags,
      destino_crucero, fecha_crucero, adultos, ninos, urgencia_compra,
      intent, type, ...rest
    } = raw;
    return {
      type: type || "intent_detected",
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
  if (last) return { first_name: String(full || "").trim(), last_name: String(last).trim() };
  const parts = String(full || "").trim().split(/\s+/);
  if (parts.length <= 1) return { first_name: parts[0] || "", last_name: "" };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

function normalizeInt(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function cleanDate(v) {
  if (!v) return undefined;
  // admite "2025-08-01", "01/08/2025", etc. → deja string tal cual (Clientify guarda string)
  return String(v).trim();
}

// ── Config Clientify ─────────────────────────────────────────
const CLIENTIFY_BASE = (process.env.CLIENTIFY_BASE_URL?.trim()) || "https://api.clientify.net/v1";

const RAW_TOKEN = process.env.CLIENTIFY_TOKEN || "";
const CLEAN_TOKEN = String(RAW_TOKEN).replace(/^['"]|['"]$/g, "").replace(/[\r\n]/g, "").trim();

const clientify = axios.create({
  baseURL: CLIENTIFY_BASE,
  headers: { Authorization: `Token ${CLEAN_TOKEN}`, Accept: "application/json" },
  timeout: 15000,
  validateStatus: () => true
});

// IDs de campos personalizados (opcionales)
const CF_IDS = {
  destino: process.env.CLIENTIFY_CF_DESTINO_ID || "",
  fecha: process.env.CLIENTIFY_CF_FECHA_ID || "",
  adultos: process.env.CLIENTIFY_CF_ADULTOS_ID || "",
  ninos: process.env.CLIENTIFY_CF_NINOS_ID || "",
  urgencia: process.env.CLIENTIFY_CF_URGENCIA_ID || ""
};

// ── Helpers Clientify ────────────────────────────────────────
function contactHasEmail(contact, email) {
  if (!email) return false;
  const target = String(email).toLowerCase();
  const list = contact?.emails;
  if (!Array.isArray(list)) return false;
  return list.some(e =>
    typeof e === "string"
      ? e.toLowerCase() === target
      : (e?.email || "").toLowerCase() === target
  );
}

async function searchByEmail(email) {
  const res = await clientify.get("/contacts/", { params: { query: email } });
  if (res.status >= 200 && res.status < 300) {
    const match = (res.data?.results || []).find(c => contactHasEmail(c, email));
    return match || null;
  }
  if (res.status === 404) throw new Error(`GET /contacts/?query=${email} -> 404`);
  return null;
}

async function searchByPhone(phone) {
  const res = await clientify.get("/contacts/", { params: { phone } });
  if (res.status >= 200 && res.status < 300) {
    return (res.data?.results || [])[0] || null;
  }
  if (res.status === 404) throw new Error(`GET /contacts/?phone=${phone} -> 404`);
  return null;
}

async function createContact({ first_name, last_name, email, phone, source, tags = [], summary }) {
  const body = {
    first_name,
    last_name,
    email,
    phone,
    contact_source: source || "AI Agent",
    tags: tags || [],
    summary: summary || ""
  };
  const res = await clientify.post("/contacts/", body);
  if (res.status >= 200 && res.status < 300) return res.data;
  throw new Error(`createContact -> ${res.status} ${JSON.stringify(res.data)}`);
}

async function addNote({ contactId, content }) {
  if (!content) return;
  const body = { name: "Datos del Agente", comment: content };
  const res = await clientify.post(`/contacts/${contactId}/note/`, body);
  if (res.status >= 200 && res.status < 300) return res.data;
  // No rompemos el flujo si no se puede crear la nota
  console.warn("addNote WARN ->", res.status, res.data);
}

async function updateCustomFields(contactId, { destino, fecha, adultos, ninos, urgencia }) {
  // Si no hay ningún ID configurado o ningún valor, salimos
  const entries = [
    { id: CF_IDS.destino, value: destino },
    { id: CF_IDS.fecha, value: fecha },
    { id: CF_IDS.adultos, value: adultos },
    { id: CF_IDS.ninos, value: ninos },
    { id: CF_IDS.urgencia, value: urgencia }
  ].filter(e => e.id && (e.value !== undefined && e.value !== null && e.value !== ""));

  if (entries.length === 0) return;

  // Formato más común: custom_fields como array { custom_field: id, value }
  const payload1 = {
    custom_fields: entries.map(e => ({ custom_field: e.id, value: String(e.value) }))
  };

  let res = await clientify.patch(`/contacts/${contactId}/`, payload1);
  if (res.status >= 200 && res.status < 300) return res.data;

  // Alternativa (algunas cuentas usan esta estructura)
  const payload2 = {
    custom_fields_values: entries.map(e => ({ id: e.id, value: String(e.value) }))
  };
  res = await clientify.patch(`/contacts/${contactId}/`, payload2);
  if (res.status >= 200 && res.status < 300) return res.data;

  console.warn("updateCustomFields WARN ->", res.status, res.data);
}

// ── Validación ───────────────────────────────────────────────
function validateEnvelope(body) {
  if (!body || typeof body !== "object") return "Body vacío o no es JSON";
  const { type, intent, payload } = body;
  if (type !== "intent_detected") return "type debe ser 'intent_detected'";
  if (!intent) return "Falta 'intent'";
  if (!payload || typeof payload !== "object") return "Falta 'payload'";
  return null;
}

function validateCreateLeadPayload(p) {
  if (!p?.name && !p?.first_name) return "Falta 'name' o 'first_name' en payload";
  if (!p.email && !p.phone) return "Debes enviar al menos 'email' o 'phone'";
  return null;
}

// ── Handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    if (!CLEAN_TOKEN) return res.status(500).json({ error: "CLIENTIFY_TOKEN no está definido" });

    if (process.env.ELEVENLABS_SECRET) {
      const incoming = req.headers["x-elevenlabs-secret"];
      if (incoming !== process.env.ELEVENLABS_SECRET) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    let envelope = wrapIfFlat(req.body);
    const dryRun = isDryRun(req);
    if (dryRun) {
      return res.status(200).json({
        ok: true,
        mode: "dry-run",
        intent: envelope.intent ?? "unknown",
        received: envelope.payload ?? envelope
      });
    }

    const vErr = validateEnvelope(envelope);
    if (vErr) return res.status(400).json({ error: vErr });

    const { intent, payload } = envelope;

    switch (intent) {
      case "create_lead": {
        const pErr = validateCreateLeadPayload(payload);
        if (pErr) return res.status(400).json({ error: pErr });

        const {
          name, last_name, email, phone, summary, source, tags,
          destino_crucero, fecha_crucero, adultos, ninos, urgencia_compra
        } = payload;

        // Nombre y apellidos
        const { first_name, last_name: ln } = splitName(name, last_name);

        // 1) Buscar contacto
        let contact = null;
        if (email) contact = await searchByEmail(email);
        if (!contact && phone) contact = await searchByPhone(phone);

        // 2) Crear si no existe
        if (!contact) {
          contact = await createContact({
            first_name,
            last_name: ln,
            email,
            phone,
            source,
            tags,
            summary
          });
        }

        // 3) Nota con la información de crucero (si hay datos)
        const adultsNum = normalizeInt(adultos);
        const kidsNum = normalizeInt(ninos);
        const fechaNorm = cleanDate(fecha_crucero);
        const nota =
          `Datos del lead:\n` +
          (destino_crucero ? `- Destino crucero: ${destino_crucero}\n` : "") +
          (fechaNorm ? `- Fecha crucero: ${fechaNorm}\n` : "") +
          (adultsNum !== undefined ? `- Adultos: ${adultsNum}\n` : "") +
          (kidsNum !== undefined ? `- Niños: ${kidsNum}\n` : "") +
          (urgencia_compra ? `- Urgencia de compra: ${urgencia_compra}\n` : "") +
          (summary ? `- Resumen: ${summary}\n` : "");
        if (nota.trim() !== "Datos del lead:") {
          await addNote({ contactId: contact.id, content: nota });
        }

        // 4) Actualizar campos personalizados (si hay IDs configurados)
        await updateCustomFields(contact.id, {
          destino: destino_crucero,
          fecha: fechaNorm,
          adultos: adultsNum,
          ninos: kidsNum,
          urgencia: urgencia_compra
        });
		
        console.log("✅ contact", contact?.id);
        return res.status(200).json({
          ok: true,
          base: CLIENTIFY_BASE,
          contactId: contact.id
        });
      }

      default:
        return res.status(200).json({ ok: true, message: `Intent '${intent}' no implementado` });
    }
  } catch (e) {
    console.error("ERROR", e.response?.status, e.response?.config?.url, e.response?.data || e.message);
    return res.status(500).json({
      error: "Clientify integration failed",
      status: e.response?.status,
      url: e.response?.config?.url,
      details: e.response?.data || e.message
    });
  }
}



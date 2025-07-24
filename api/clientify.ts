import axios from "axios";

const client = axios.create({
  baseURL: "https://api.clientify.com/api/v1",
  headers: { Authorization: `Token ${process.env.CLIENTIFY_TOKEN}` }
});

export async function findContactByEmail(email: string) {
  const res = await client.get("/contacts/", { params: { email } });
  return res.data.results?.[0] ?? null;
}

export async function createContact({ name, email, phone }: any) {
  const res = await client.post("/contacts/", {
    name, email, phone, tags: ["AI_Agent"]
  });
  return res.data;
}

export async function createDeal({ name, contactId }: any) {
  const res = await client.post("/deals/", {
    name, contact: contactId, stage: 1 // ajusta al pipeline
  });
  return res.data;
}

export async function addNote({ contactId, content }: any) {
  await client.post("/notes/", { content, contact: contactId });
}

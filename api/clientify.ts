// api/clientify.js
import axios from "axios";

const client = axios.create({
  baseURL: "https://api.clientify.com/api/v1",
  headers: { Authorization: `Token ${process.env.CLIENTIFY_TOKEN}` }
});

export async function findContactByEmail(email) { /* ... */ }
export async function createContact(data) { /* ... */ }
export async function createDeal(data) { /* ... */ }
export async function addNote(data) { /* ... */ }


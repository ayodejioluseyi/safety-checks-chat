export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import * as chrono from "chrono-node"; // ✅ no default export
import { loadKB, topKByCosine, KBItem } from "@/lib/search";

type ChatRole = "user" | "assistant" | "system";
type ChatMessage = { role: ChatRole; content: string };
interface ChatBody { messages: ChatMessage[] }

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function toIsoDate(s?: string): string | undefined {
  if (!s) return undefined;
  const results = chrono.parse(s, new Date(), { forwardDate: true });
  const d = results[0]?.date();
  if (!d) return undefined;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const TYPE_ALIASES: Record<string, string> = {
  "opening": "Opening_Check",
  "open": "Opening_Check",
  "closing": "Closing_Check",
  "fridge am": "Fridge_AM",
  "fridge pm": "Fridge_PM",
  "cold holding": "Cold_Holding",
  "hot holding": "Hot_Holding",
  "daily cleaning": "Daily_Cleaning",
  "weekly cleaning": "Weekly_Cleaning",
  "monthly cleaning": "Monthly_Cleaning",
  "adhoc cleaning": "Adhoc_Cleaning",
  "defrosting": "Defrosting",
  "cooking": "Cooking",
  "cooling": "Cooling_of_Hot_Food",
  "reheating": "Re-heating",
  "re-heating": "Re-heating"
};

function detectType(userMsg: string): string | undefined {
  const msg = userMsg.toLowerCase();
  for (const k of Object.keys(TYPE_ALIASES)) {
    if (msg.includes(k)) return TYPE_ALIASES[k];
  }
  return undefined;
}

function prefilter(kb: KBItem[], userMsg: string): KBItem[] {
  const ridMatch = userMsg.match(/\b(restaurant|site|key)\s*#?\s*(\d+)\b/i);
  const dateGuess = toIsoDate(userMsg);
  const typeGuess = detectType(userMsg);
  const nameMatch = userMsg.match(/restaurant\s+["“]?([^"\n\r]+?)["”]?(?:\s|$|\?|\.)/i);
  const nameGuess = nameMatch?.[1]?.trim()?.toLowerCase();

  let items = kb;
  if (ridMatch?.[2]) items = items.filter(x => x.meta?.restaurant_key === ridMatch[2]);
  if (nameGuess && nameGuess.length >= 3)
    items = items.filter(x => (x.meta?.restaurant_name ?? "").toLowerCase().includes(nameGuess));
  if (dateGuess) items = items.filter(x => (x.meta?.date_iso ?? "").startsWith(dateGuess));
  if (typeGuess) items = items.filter(x => (x.meta?.type ?? "") === typeGuess);
  return items;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatBody; // ✅ typed body
    const userMsg = body.messages?.[body.messages.length - 1]?.content ?? "";

    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userMsg
    });
    const qvec = emb.data[0].embedding;

    const kb = loadKB();
    const narrowed = prefilter(kb, userMsg);
    const searchSpace = narrowed.length ? narrowed : kb;

    const top = topKByCosine(qvec, searchSpace, 12);
    const context = top.map(t => `- ${t.text} [id:${t.id}]`).join("\n");

    const system = `
You are a helpful assistant for restaurant food-safety checks.
Answer ONLY from the "Context" lines. If the context doesn't contain the answer, say you don't have that record.
When dates like "today" are used, interpret them in Europe/London and include the explicit date (YYYY-MM-DD).
Cite ids inline like [id:row-123]. Be concise and human-like.
    `.trim();

    const prompt = `Context:\n${context || "(no matching records found)"}\n\nUser question: ${userMsg}`;

    const chat = await openai.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ]
    });

    const answer = chat.choices[0]?.message?.content?.trim() || "Sorry, I couldn't produce an answer.";
    return NextResponse.json({ answer, used: top.map(t => t.id), narrowedCount: narrowed.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "server error"; // ✅ no 'any'
    console.error(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

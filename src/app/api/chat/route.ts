export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import * as chrono from "chrono-node";
import { loadKB, topKByCosine, type KBItem } from "@/lib/search";

type ChatRole = "user" | "assistant" | "system";
type ChatMessage = { role: ChatRole; content: string };
interface ChatBody { messages: ChatMessage[] }

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- helpers: date + types + friendly summaries ---------- */

function toIsoDate(s?: string): string | undefined {
  if (!s) return undefined;

  // DD/MM/YYYY or DD-MM-YYYY (UK)
  const uk = s.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (uk) {
    const dd = parseInt(uk[1], 10);
    const mm = parseInt(uk[2], 10);
    const yyyy = parseInt(uk[3], 10);
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  // ISO YYYY-MM-DD
  const iso = s.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (iso) return iso[0];

  // Chrono fallback
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
  "re-heating": "Re-heating",
};

function detectType(userMsg: string): string | undefined {
  const msg = userMsg.toLowerCase();

  // Tolerate fridge typos
  if (/(fridge|frdge|friedge)/.test(msg)) {
    if (/\bpm\b/.test(msg)) return "Fridge_PM";
    if (/\bam\b/.test(msg)) return "Fridge_AM";
  }

  for (const k of Object.keys(TYPE_ALIASES)) {
    if (msg.includes(k)) return TYPE_ALIASES[k];
  }
  return undefined;
}

function humanType(t: string | undefined): string {
  if (!t) return "check";
  return t.replace(/_/g, " ").replace(/\bAM\b/, "AM").replace(/\bPM\b/, "PM");
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function humanDate(iso?: string): string {
  if (!iso || iso.length < 10) return iso ?? "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const month = date.toLocaleString("en-GB", { month: "long" });
  return `${ordinal(d)} ${month} ${y}`;
}

// Parse numbers from our KB sentence. If it fails, return null.
function parseStatsFromText(text: string): {
  checks: number; completed: number; passed: number; compPct: number; passPct: number;
} | null {
  const m = text.match(/checks=(\d+)\s+completed=(\d+)\s+passed=(\d+)\s+\(comp=(\d+)%?,\s*pass=(\d+)%?\)/i);
  if (!m) return null;
  return {
    checks: parseInt(m[1], 10),
    completed: parseInt(m[2], 10),
    passed: parseInt(m[3], 10),
    compPct: parseInt(m[4], 10),
    passPct: parseInt(m[5], 10),
  };
}

type Stats = {
  checks: number; completed: number; passed: number; compPct: number; passPct: number;
};

function tailFor({ checks, completed, passed, compPct, passPct }: Stats): string {
  // Derived counts
  const notCompleted = Math.max(checks - completed, 0);
  const failed = Math.max(completed - passed, 0);

  // No checks at all
  if (checks === 0) return " No checks were recorded for this entry.";

  // Perfect
  if (compPct === 100 && passPct === 100) return " Well done — keep it up.";

  // All passed but not all completed
  if (passPct === 100 && compPct >= 90 && notCompleted > 0) {
    return ` All checks passed; ${notCompleted} ${notCompleted === 1 ? "check remains" : "checks remain"} to reach 100% completion.`;
  }

  // Fully completed but a few failed
  if (compPct === 100 && passPct >= 95 && failed > 0) {
    return ` Great completion — ${failed} ${failed === 1 ? "item failed" : "items failed"}. Please review and monitor.`;
  }

  // Mixed gaps (minor)
  if (passPct >= 90) {
    const parts: string[] = [];
    if (notCompleted > 0) parts.push(`${notCompleted} not completed`);
    if (failed > 0) parts.push(`${failed} failed`);
    return ` Some gaps: ${parts.join(", ")}. Please follow up.`;
  }

  // Larger issues
  if (passPct >= 70) {
    const parts: string[] = [];
    if (notCompleted > 0) parts.push(`${notCompleted} not completed`);
    if (failed > 0) parts.push(`${failed} failed`);
    return ` Noticeable issues — ${parts.join(", ")}. Corrective action is recommended.`;
  }

  // Significant issues
  const parts: string[] = [];
  if (notCompleted > 0) parts.push(`${notCompleted} not completed`);
  if (failed > 0) parts.push(`${failed} failed`);
  return ` Several items did not meet standards (${parts.join(", ")}). Immediate corrective action is advised.`;
}

// Deterministic humanisation for exact matches
function summariseExact(item: KBItem): string {
  const dn = humanDate(item.meta?.date_iso);
  const tHuman = humanType(item.meta?.type).toLowerCase();
  const name = item.meta?.restaurant_name?.trim() || `restaurant ${item.meta?.restaurant_key ?? ""}`;
  const stats = parseStatsFromText(item.text);

  if (!stats) {
    // Fallback to original text if parsing ever fails
    return item.text.replace(/\s*\[id:[^\]]+\]/gi, "").trim();
  }

  const { checks, completed, passed, compPct, passPct } = stats;

  const base = `On ${dn}, the ${tHuman} for ${name} had a total of ${checks} checks, with ${completed} completed and ${passed} passed, resulting in ${compPct}% completion and ${passPct}% pass rate.`;
  return base + tailFor({ checks, completed, passed, compPct, passPct });
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

/* ---------- route ---------- */

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatBody;
    const userMsg = body?.messages?.[body.messages.length - 1]?.content?.trim() ?? "";

    if (!userMsg) {
      return NextResponse.json({ error: "Missing message content" }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "Server missing OPENAI_API_KEY" }, { status: 500 });
    }

    // Load KB once
    const kb = loadKB();

    // ---- Exact-match fast path (type + restaurant key + date) ----
    const ridMatch = userMsg.match(/\b(restaurant|site|key)\s*#?\s*(\d+)\b/i);
    const rid = ridMatch?.[2];
    const dateIso = toIsoDate(userMsg);
    const typeGuess = detectType(userMsg);

    if (rid && dateIso && typeGuess) {
      const exact = kb.find(
        (x) =>
          x.meta?.restaurant_key === rid &&
          (x.meta?.date_iso ?? "").startsWith(dateIso) &&
          x.meta?.type === typeGuess
      );
      if (exact) {
        return NextResponse.json({
          answer: summariseExact(exact), // ← friendly, deterministic summary
          used: [exact.id],
          narrowedCount: 1,
        });
      }
    }

    // ---- Embed the query for semantic retrieval ----
    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userMsg,
    });
    const qvec = emb.data[0]?.embedding;
    if (!qvec) {
      return NextResponse.json({ error: "Embedding failed" }, { status: 500 });
    }

    // ---- Retrieve context ----
    const narrowed = prefilter(kb, userMsg);
    const searchSpace = narrowed.length ? narrowed : kb;
    const top = topKByCosine(qvec, searchSpace, 12);

    if (top.length === 0) {
      return NextResponse.json({
        answer: "I don’t have that record in the current dataset. Try one of the suggestions below.",
        used: [],
        narrowedCount: narrowed.length,
      });
    }

    const context = top.map(t => `- ${t.text}`).join("\n");

    const system = `
You are a helpful assistant for restaurant food-safety checks.
Answer ONLY from the "Context" lines. Do not invent data. If the context doesn't contain the answer, say you don't have that record.
Rewrite the result as a clear, human summary like:
"On 31st August 2025, the opening check for Grand Cafe had a total of 13 checks, with 13 completed and 13 passed, resulting in 100% completion and 100% pass rate."
Use UK dates with an ordinal day (e.g., 1st/2nd/3rd/4th) and full month. If both completion and pass are 100%, end with "Well done — keep it up." Keep it to one or two sentences.
`.trim();

    const prompt = `Context:\n${context}\n\nUser question: ${userMsg}`;

    const chat = await openai.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });

    const raw = chat.choices[0]?.message?.content ?? "";
    const cleaned = raw.replace(/\s*\[id:[^\]]+\]/gi, "").replace(/\s{2,}/g, " ").trim();

    return NextResponse.json({
      answer: cleaned || "Sorry, I couldn't produce an answer.",
      used: top.map(t => t.id),
      narrowedCount: narrowed.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "server error";
    console.error(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { loadKB, type KBItem } from "@/lib/search";

// ---- aliases (same as chat) ----
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

function detectType(text: string): string | undefined {
  const msg = text.toLowerCase();
  for (const k of Object.keys(TYPE_ALIASES)) {
    if (msg.includes(k)) return TYPE_ALIASES[k];
  }
  return undefined;
}

function toDDMMYYYY(iso: string): string {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function humanType(t: string): string {
  return t.replace(/_/g, " ").replace(/\bAM\b/, "AM").replace(/\bPM\b/, "PM");
}

// ---- type guard: ensure date_iso/type/restaurant_key are present strings
type WithRequiredMeta = KBItem & {
  meta: { date_iso: string; type: string; restaurant_key: string; restaurant_name?: string };
};

function hasDateTypeKey(it: KBItem): it is WithRequiredMeta {
  const m = it.meta as Record<string, unknown> | undefined;
  return Boolean(
    m &&
      typeof m.date_iso === "string" &&
      (m.date_iso as string).length >= 10 &&
      typeof m.type === "string" &&
      typeof m.restaurant_key === "string"
  );
}

type Body = { lastUserText?: string };

export async function POST(req: NextRequest) {
  try {
    const kb = loadKB();
    const { lastUserText = "" } = (await req.json()) as Body;

    // hints from the user's failed query
    const ridMatch = lastUserText.match(/\b(restaurant|site|key)\s*#?\s*(\d+)\b/i);
    const rid = ridMatch?.[2];

    const nameMatch = lastUserText.match(/restaurant\s+["“]?([^"\n\r]+?)["”]?(?:\s|$|\?|\.)/i);
    const name = nameMatch?.[1]?.trim().toLowerCase();

    const typeGuess = detectType(lastUserText);

    // base set
    let items: KBItem[] = kb;

    // pre-filters (safe with optional chaining)
    if (typeGuess) items = items.filter(x => x.meta?.type === typeGuess);
    if (rid) items = items.filter(x => x.meta?.restaurant_key === rid);
    if (!rid && name && name.length >= 3) {
      items = items.filter(x => (x.meta?.restaurant_name ?? "").toLowerCase().includes(name));
    }

    // if filters gave nothing, fall back to all
    if (items.length === 0) items = kb;

    // narrow to items that definitely have date/type/key, then sort by newest
    const dated: WithRequiredMeta[] = items
      .filter(hasDateTypeKey)
      .sort((a, b) => (a.meta.date_iso < b.meta.date_iso ? 1 : -1));

    // build up to 7 distinct prompts
    const suggestions: string[] = [];
    const seen = new Set<string>();
    for (const it of dated) {
      const { restaurant_key: key, date_iso, type } = it.meta;
      const prompt = `${humanType(type)} for restaurant ${key} on ${toDDMMYYYY(date_iso)}`;
      if (seen.has(prompt)) continue;
      seen.add(prompt);
      suggestions.push(prompt);
      if (suggestions.length >= 7) break;
    }

    return NextResponse.json({ suggestions });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "suggestions error";
    return NextResponse.json({ suggestions: [], error: message }, { status: 500 });
  }
}

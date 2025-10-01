export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { loadKB, type KBItem } from "@/lib/search";

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

type Body = {
  lastUserText?: string;
  preferredTypes?: string[]; // internal names e.g. "Opening_Check"
  limit?: number;
};

export async function POST(req: NextRequest) {
  try {
    const kb = loadKB();
    const { lastUserText = "", preferredTypes = [], limit = 7 } = (await req.json()) as Body;

    // Parse hints from user's text (optional)
    const ridMatch = lastUserText.match(/\b(restaurant|site|key)\s*#?\s*(\d+)\b/i);
    const rid = ridMatch?.[2];
    const nameMatch = lastUserText.match(/restaurant\s+["“]?([^"\n\r]+?)["”]?(?:\s|$|\?|\.)/i);
    const name = nameMatch?.[1]?.trim().toLowerCase();
    const typeGuess = detectType(lastUserText);

    // Base set
    let items: KBItem[] = kb;
    if (typeGuess) items = items.filter((x) => x.meta?.type === typeGuess);
    if (rid) items = items.filter((x) => x.meta?.restaurant_key === rid);
    if (!rid && name && name.length >= 3) {
      items = items.filter((x) => (x.meta?.restaurant_name ?? "").toLowerCase().includes(name));
    }
    if (items.length === 0) items = kb;

    // Only items with required meta, newest first
    const dated = items.filter(hasDateTypeKey).sort((a, b) =>
      a.meta.date_iso < b.meta.date_iso ? 1 : -1
    );

    const seenPrompts = new Set<string>();
    const usedIndexes = new Set<number>();
    const out: string[] = [];

    // Helper: add suggestion from item index if not duplicate
    const addFrom = (idx: number) => {
      const it = dated[idx];
      const prompt = `${humanType(it.meta.type)} for restaurant ${it.meta.restaurant_key} on ${toDDMMYYYY(it.meta.date_iso)}`;
      if (seenPrompts.has(prompt)) return false;
      seenPrompts.add(prompt);
      usedIndexes.add(idx);
      out.push(prompt);
      return true;
    };

    // 1) One per preferred type, in order
    for (const t of preferredTypes) {
      const idx = dated.findIndex((it) => it.meta.type === t);
      if (idx >= 0) {
        addFrom(idx);
        if (out.length >= limit) break;
      }
    }

    // 2) Fill remaining with most recent overall (skipping duplicates)
    for (let i = 0; i < dated.length && out.length < limit; i++) {
      addFrom(i);
    }

    return NextResponse.json({ suggestions: out });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "suggestions error";
    return NextResponse.json({ suggestions: [], error: message }, { status: 500 });
  }
}

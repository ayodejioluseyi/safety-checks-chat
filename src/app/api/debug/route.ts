export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { loadKB, type KBItem } from "@/lib/search";

type Sample = Pick<KBItem, "id" | "text" | "meta">;

export async function GET() {
  try {
    const kb = loadKB();
    const sample: Sample[] = kb.slice(0, 3).map(({ id, text, meta }) => ({ id, text, meta }));
    return NextResponse.json({ count: kb.length, sample });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "read error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

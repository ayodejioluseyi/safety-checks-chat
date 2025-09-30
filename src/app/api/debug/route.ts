export const runtime = "nodejs";
import { NextResponse } from "next/server";
import { loadKBBin, type KBItem } from "@/lib/search";

type Sample = Pick<KBItem,"id"|"text"|"meta">;

export async function GET() {
  try {
    const { count, items } = loadKBBin();
    const sample: Sample[] = items.slice(0,3).map(({id,text,meta})=>({id,text,meta}));
    return NextResponse.json({ count, sample });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "read error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

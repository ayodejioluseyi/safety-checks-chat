import fs from "fs";
import path from "path";

export interface KBMeta {
  restaurant_key?: string;
  restaurant_name?: string;
  date_iso?: string;
  type?: string;
  // allow other metadata fields without using `any`
  [k: string]: unknown;
}

export interface KBItem {
  id: string;
  text: string;
  embedding: number[];
  meta: KBMeta;
  score?: number;
}

let KB: KBItem[] | null = null;

export function loadKB(): KBItem[] {
  if (KB) return KB;
  const p = path.join(process.cwd(), "data", "knowledge.json");
  const raw = fs.readFileSync(p, "utf8");
  // We trust our builder to produce the correct shape
  KB = JSON.parse(raw) as KBItem[];
  return KB!;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) + 1e-9;
  return dot / denom;
}

export function topKByCosine(
  queryVec: number[],
  items: KBItem[],
  k = 12
): KBItem[] {
  return items
    .map((it) => ({ ...it, score: cosine(queryVec, it.embedding) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, k);
}

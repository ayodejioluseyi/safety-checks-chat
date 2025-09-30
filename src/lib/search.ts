import fs from "fs";
import path from "path";

export interface KBMeta {
  restaurant_key?: string;
  restaurant_name?: string;
  date_iso?: string;
  type?: string;
  [k: string]: unknown;
}
export interface KBItem { id: string; text: string; meta: KBMeta; score?: number; }
export interface KBBin {
  dim: number;
  count: number;
  items: KBItem[];
  vec: Float32Array; // normalized vectors, length = count*dim
}

let BIN: KBBin | null = null;

export function loadKB(): KBItem[] {
  return loadKBBin().items;
}

export function loadKBBin(): KBBin {
  if (BIN) return BIN;

  const metaPath = path.join(process.cwd(), "data", "kb.meta.json");
  const binPath  = path.join(process.cwd(), "data", "kb.vec.bin");

  const metaRaw = fs.readFileSync(metaPath, "utf8");
  const { dim, count, items } = JSON.parse(metaRaw) as { dim: number; count: number; items: KBItem[] };

  const buf = fs.readFileSync(binPath); // Node Buffer
  const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

  if (vec.length !== count * dim) {
    throw new Error(`Vector file length mismatch: have ${vec.length}, expected ${count*dim}`);
  }

  BIN = { dim, count, items, vec };
  return BIN!;
}

// cosine with stored unit vectors -> just dot / ||q||
function cosineToUnit(query: number[], unitVec: Float32Array, base: number, dim: number): number {
  let dot = 0, qnorm = 0;
  for (let j=0;j<dim;j++){
    const qj = query[j];
    dot   += qj * unitVec[base + j];
    qnorm += qj * qj;
  }
  return dot / (Math.sqrt(qnorm) + 1e-9);
}

export function topKByCosine(queryVec: number[], items: KBItem[], k = 12): KBItem[] {
  const { dim, vec } = loadKBBin();
  // items are in the same order as vectors; index by position
  // build an index map once
  const index = new Map<string, number>();
  const all = loadKBBin().items;
  for (let i=0;i<all.length;i++) index.set(all[i].id, i);

  const scored: KBItem[] = [];
  for (const it of items) {
    const idx = index.get(it.id);
    if (idx == null) continue;
    const score = cosineToUnit(queryVec, vec, idx*dim, dim);
    scored.push({ ...it, score });
  }
  return scored.sort((a,b)=>(b.score ?? 0)-(a.score ?? 0)).slice(0,k);
}

// scripts/build-knowledge-bin.mjs
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true });

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import OpenAI from "openai";

// ---------- CLI args ----------
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.split("=");
  return [k.replace(/^--/, ""), v ?? true];
}));
const SINCE   = args.since || null;                 // "YYYY-MM-DD"
const YEAR    = args.year ? parseInt(args.year,10) : null;
const TYPES   = args.types ? args.types.split(",") : null;
const LIMIT   = args.limit ? parseInt(args.limit,10) : null;
const MAXFACTS= args.maxFacts ? parseInt(args.maxFacts,10) : null;

// ---------- constants ----------
const ALL_TYPES = [
  "Adhoc_Cleaning","Closing_Check","Cold_Holding","Cooking","Cooling_of_Hot_Food",
  "Daily_Cleaning","Defrosting","Fridge_AM","Fridge_PM","Hot_Holding",
  "Monthly_Cleaning","Opening_Check","Re-heating","Weekly_Cleaning"
];
const ACTIVE_TYPES = TYPES ?? ALL_TYPES;

const get = (row, key) => (row[key] ?? "").toString().trim();
const asNum = v => (v === "" || v == null ? 0 : (Number(v) || 0));
function toISO(dmy) {
  const m = (dmy ?? "").match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return dmy ?? "";
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
}
const toHuman = s => s.replace(/_/g," ").replace(/\bAM\b/,"AM").replace(/\bPM\b/,"PM");

function makeSentence(row, type) {
  const restKey  = get(row,"restaurant_key");
  let   restName = get(row,"restaurant_name").replace(/[,\s]+$/g,"");
  const iso      = toISO(get(row,"date"));

  const completion = asNum(get(row, `${type}-CompletionRatio`));
  const nChecks    = asNum(get(row, `${type}-NumberOfChecks`));
  const nDone      = asNum(get(row, `${type}-NumberOfCompletedChecks`));
  const nPass      = asNum(get(row, `${type}-NumberOfPassedChecks`));
  const passRatio  = asNum(get(row, `${type}-PassRatio`));
  if (!(nChecks > 0 || completion > 0 || passRatio > 0)) return null;

  const compPct = Math.round(completion * 100);
  const passPct = Math.round(passRatio * 100);
  return `On ${iso}, restaurant ${restKey}${restName?` (${restName})`:""} — ${toHuman(type)}: checks=${nChecks} completed=${nDone} passed=${nPass} (comp=${compPct}%, pass=${passPct}%).`;
}

function factsFromRow(row, rowIdx, activeTypes) {
  const iso = toISO(get(row,"date"));
  if (YEAR && (!iso || !iso.startsWith(String(YEAR)))) return [];
  if (SINCE && iso && iso < SINCE) return [];
  const facts=[];
  for (const type of activeTypes){
    const text = makeSentence(row, type);
    if (text){
      facts.push({
        id: `row${rowIdx+1}-${type}`,
        text,
        meta: {
          type,
          restaurant_key: get(row,"restaurant_key"),
          restaurant_name: get(row,"restaurant_name").replace(/[,\s]+$/g,""),
          date_iso: iso
        }
      });
    }
  }
  return facts;
}

function chunk(arr, n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function main(){
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing (.env.local)");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const csvPath = path.join(process.cwd(),"data","checks.csv");
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found at ${csvPath}`);

  const raw = fs.readFileSync(csvPath, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  const rowsToUse = LIMIT ? rows.slice(0, LIMIT) : rows;

  console.log("📦 Rows:", rows.length, "| using:", rowsToUse.length);
  console.log("⚙️ Filters:", { YEAR, SINCE, TYPES: ACTIVE_TYPES });

  // Build facts
  let facts=[];
  rowsToUse.forEach((row, i)=>{
    const f = factsFromRow(row, i, ACTIVE_TYPES);
    if (f.length) facts.push(...f);
  });

  // De-dupe identical text lines
  const seen = new Set();
  facts = facts.filter(f=>{ if (seen.has(f.text)) return false; seen.add(f.text); return true; });

  if (MAXFACTS && facts.length > MAXFACTS) {
    console.log(`✂️ Trimming facts from ${facts.length} to ${MAXFACTS}`);
    facts = facts.slice(0, MAXFACTS);
  }

  console.log("🧾 Facts to embed:", facts.length);
  if (facts.length === 0) throw new Error("No facts to embed.");

  // Embed in batches
  const batches = chunk(facts, 100);
  const vectors = []; // each is Float32Array-like (JS array first)
  let DIM = 0, done = 0;
  for (let bi=0; bi<batches.length; bi++){
    const b = batches[bi];
    let ok=false, tries=0;
    while(!ok && tries<5){
      try{
        const resp = await client.embeddings.create({ model: "text-embedding-3-small", input: b.map(x=>x.text) });
        if (!DIM) DIM = resp.data[0].embedding.length;

        // Normalize each vector to unit length (better cosine)
        for (let i=0;i<resp.data.length;i++){
          const e = resp.data[i].embedding;
          let norm=0; for (let j=0;j<e.length;j++) norm += e[j]*e[j];
          norm = Math.sqrt(norm) + 1e-9;
          for (let j=0;j<e.length;j++) e[j] = e[j]/norm;
          vectors.push(e);
        }
        done += b.length;
        ok = true;
        if (done % 500 === 0 || done === facts.length) console.log(`… embedded ${done}/${facts.length}`);
      }catch(err){
        tries++;
        const status = err?.status || err?.response?.status;
        console.warn(`⚠️ Batch ${bi+1}/${batches.length} failed (try ${tries})`, status);
        await sleep(status === 429 ? 2000*tries : 1000*tries);
      }
    }
    if (!ok) throw new Error("Failed after retries.");
  }

  // Pack into Float32 binary file
  const total = vectors.length;
  const floatCount = total * DIM;
  const f32 = new Float32Array(floatCount);
  for (let i=0;i<total;i++){
    const base = i*DIM;
    const e = vectors[i];
    for (let j=0;j<DIM;j++) f32[base+j] = e[j];
  }

  // Files
  const outDir   = path.join(process.cwd(),"data");
  const binPath  = path.join(outDir,"kb.vec.bin");
  const metaPath = path.join(outDir,"kb.meta.json");

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive:true });

  fs.writeFileSync(binPath, Buffer.from(f32.buffer));
  fs.writeFileSync(metaPath, JSON.stringify({
    dim: DIM,
    count: facts.length,
    items: facts.map(({id,text,meta})=>({id,text,meta}))
  }));

  console.log(`✅ Wrote ${binPath} (${(f32.byteLength/1e6).toFixed(1)} MB) and ${metaPath}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });

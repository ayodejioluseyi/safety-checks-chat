// scripts/build-knowledge.mjs
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true });

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import OpenAI from "openai";




// -------------------------------------------------------
// CLI args
//   --since=YYYY-MM-DD                    (filters rows by date >= since)
//   --types=Opening_Check,Fridge_AM,...   (limits which check types we emit)
//   --limit=500                           (uses only first N CSV rows, for testing)
// -------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.split("=");
    return [k.replace(/^--/, ""), v ?? true];
  })
);
const SINCE = args.since || null;
const TYPES = args.types ? args.types.split(",") : null;
const LIMIT = args.limit ? parseInt(args.limit, 10) : null;
const YEAR = args.year ? parseInt(args.year, 10) : null;
const MAX_FACTS = args.maxFacts ? parseInt(args.maxFacts, 10) : null;


// All possible types (from your CSV headers)
const ALL_CHECK_TYPES = [
  "Adhoc_Cleaning","Closing_Check","Cold_Holding","Cooking","Cooling_of_Hot_Food",
  "Daily_Cleaning","Defrosting","Fridge_AM","Fridge_PM","Hot_Holding",
  "Monthly_Cleaning","Opening_Check","Re-heating","Weekly_Cleaning"
];

const ACTIVE_TYPES = TYPES ?? ALL_CHECK_TYPES;

// --------------------- helpers -------------------------
const get = (row, key) => (row[key] ?? "").toString().trim();

function toISO(dmy) {
  if (!dmy) return "";
  // Supports 29/09/2025 or 29-09-2025
  const m = dmy.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return dmy; // fallback
  const [ , dd, mm, yyyy ] = m;
  return `${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
}

const asNum = v => (v === "" || v == null ? 0 : (Number(v) || 0));
const toHuman = s => s.replace(/_/g," ").replace(/\bAM\b/,"AM").replace(/\bPM\b/,"PM");

function makeSentence(row, type) {
  const restKey  = get(row,"restaurant_key");
  const restName = get(row,"restaurant_name");
  const iso      = toISO(get(row,"date"));

  const completion = asNum(get(row, `${type}-CompletionRatio`));
  const nChecks    = asNum(get(row, `${type}-NumberOfChecks`));
  const nDone      = asNum(get(row, `${type}-NumberOfCompletedChecks`));
  const nPass      = asNum(get(row, `${type}-NumberOfPassedChecks`));
  const passRatio  = asNum(get(row, `${type}-PassRatio`));

  // Only emit if there is activity
  if (!(nChecks > 0 || completion > 0 || passRatio > 0)) return null;

  return `On ${iso}, restaurant ${restKey}${restName?` (${restName})`:""} — ${toHuman(type)}: checks=${nChecks} completed=${nDone} passed=${nPass} (comp=${completion}, pass=${passRatio}).`;
}

function factsFromRow(row, rowIdx) {
  const iso = toISO(get(row,"date"));
  if (YEAR && (!iso || !iso.startsWith(String(YEAR)))) return [];   // <— only this year
  if (SINCE && iso && iso < SINCE) return [];

  const facts = [];
  for (const type of ACTIVE_TYPES) {
    const text = makeSentence(row, type);
    if (!text) continue;
    facts.push({
      id: `row${rowIdx+1}-${type}`,
      text,
      meta: {
        type,
        restaurant_key: get(row,"restaurant_key"),
        restaurant_name: get(row,"restaurant_name"),
        date_iso: iso
      }
    });
  }
  return facts;
}


function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------- main ---------------------------
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not found (check .env.local)");
    process.exit(1);
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const csvPath = path.join(process.cwd(), "data", "checks.csv");
  if (!fs.existsSync(csvPath)) {
    console.error(`❌ CSV not found at ${csvPath}`);
    process.exit(1);
  }

  console.log("🔎 Reading CSV…", csvPath);
  const raw = fs.readFileSync(csvPath, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  console.log("📦 Rows:", rows.length);

  const rowsToUse = LIMIT ? rows.slice(0, LIMIT) : rows;
  console.log(`🧱 Building facts from ${rowsToUse.length} rows… (since=${SINCE ?? "none"}, types=${ACTIVE_TYPES.join(",")})`);

  // Build facts
  let facts = [];
  rowsToUse.forEach((row, i) => {
    const f = factsFromRow(row, i);
    if (f.length) facts.push(...f);
  });

  // De-dupe identical text lines
  const seen = new Set();
  facts = facts.filter(f => {
    if (seen.has(f.text)) return false;
    seen.add(f.text);
    return true;
  });

  if (MAX_FACTS && facts.length > MAX_FACTS) {
    console.log(`✂️ Trimming facts from ${facts.length} to ${MAX_FACTS}`);
    facts = facts.slice(0, MAX_FACTS);
  }



  console.log("🧾 Facts to embed:", facts.length);
  if (facts.length === 0) {
    console.error("❌ No facts generated. Check filters or headers.");
    process.exit(1);
  }

  // Embed in batches with retries
  const batches = chunk(facts, 100);
  let embedded = [];
  let done = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const b = batches[bi];
    let ok = false, tries = 0;

    while (!ok && tries < 5) {
      try {
        const resp = await client.embeddings.create({
          model: "text-embedding-3-small",
          input: b.map(x => x.text)
        });
        const withVecs = b.map((fact, i) => ({
          ...fact,
          embedding: resp.data[i].embedding.map(v => Math.round(v * 1e4) / 1e4)
        }));
        embedded = embedded.concat(withVecs);
        done += b.length;
        ok = true;

        if (done % 500 === 0 || done === facts.length) {
          console.log(`… embedded ${done}/${facts.length}`);
        }
      } catch (err) {
        tries++;
        const status = err?.status || err?.response?.status;
        const msg = err?.message || err?.response?.data || err;
        console.warn(`⚠️ Embed batch ${bi+1}/${batches.length} failed (try ${tries}):`, status, msg);
        await sleep(status === 429 ? 2000 * tries : 1000 * tries);
      }
    }
    if (!ok) {
      console.error("❌ Failed after retries. Aborting.");
      process.exit(1);
    }
  }

  // Atomic write
  const outDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, "knowledge.tmp.json");
  const final = path.join(outDir, "knowledge.json");
  fs.writeFileSync(tmp, JSON.stringify(embedded), "utf8");
  fs.renameSync(tmp, final);
  console.log(`✅ Saved ${final} with ${embedded.length} vectors.`);
}

main().catch(e => { console.error(e); process.exit(1); });

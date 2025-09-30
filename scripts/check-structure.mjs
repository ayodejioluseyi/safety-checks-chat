import fs from "fs";
const mustHaveDirs = ["src/app","src/app/api","src/app/api/chat","data","src/lib","scripts"];
const mustHaveFiles = ["package.json","tsconfig.json","next.config.ts",".gitignore",".env.local","data/checks.csv","src/app/page.tsx"];
let ok = true;
for (const d of mustHaveDirs) {
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) { console.log("MISSING DIR:", d); ok = false; }
}
for (const f of mustHaveFiles) {
  if (!fs.existsSync(f)) { console.log("MISSING FILE:", f); ok = false; }
}
console.log(ok ? "✅ Structure looks good." : "❌ Structure incomplete.");
process.exit(ok ? 0 : 1);

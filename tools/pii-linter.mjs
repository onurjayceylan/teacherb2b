#!/usr/bin/env node
// PII linter: log satırlarına (console.* / logger.*) PII alan adı sızmasını engeller.
// Muafiyet: satır sonuna '// pii-ok' eklenen satırlar atlanır (bilinçli, gözden geçirilmiş loglar).
import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["packages", "apps"];

// console.log/info/warn/error çağrısı VEYA herhangi bir logger. çağrısı içeren satırlar
const LOG_CALL_RE = /\bconsole\.(log|info|warn|error)\s*\(|\blogger\./;
// PII kelimeleri identifier olarak: başında/sonunda başka identifier karakteri olmamalı
const PII_RE = /(^|[^A-Za-z0-9_$])(email|iban|phone|tax_id|national_id)(?![A-Za-z0-9_$])/i;
const EXEMPT_MARKER = "// pii-ok";

/** src/ altındaki .ts dosyalarını toplar; node_modules'a girmez. */
function collectSourceFiles(dir, insideSrc, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, insideSrc || entry === "src", out);
    } else if (insideSrc && entry.endsWith(".ts")) {
      out.push(full);
    }
  }
}

const files = [];
for (const root of SCAN_ROOTS) {
  const abs = path.join(repoRoot, root);
  try {
    if (statSync(abs).isDirectory()) collectSourceFiles(abs, false, files);
  } catch {
    // dizin yoksa sorun değil
  }
}

const violations = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes(EXEMPT_MARKER)) return;
    if (LOG_CALL_RE.test(line) && PII_RE.test(line)) {
      violations.push(`${path.relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error("pii-linter: log satırında PII alan adı bulundu — maskeleyin veya '// pii-ok' ile işaretleyin:");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(`pii-linter: temiz (${files.length} dosya tarandı)`);

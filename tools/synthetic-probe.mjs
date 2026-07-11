#!/usr/bin/env node
// Sentetik prob — dış izlemeye (Checkly) taşınacak uçtan uca sağlık kontrolü.
// Oturum GEREKTİRMEZ; BASE_URL env'ine karşı 4 hafif kontrol koşar:
//   1. GET /api/healthz  → 200 + ok:true + db:"up"; paymentsFrozen=true ise EXIT 2 (para donuk alarmı)
//   2. GET /             → 200 (giriş sayfası ayakta)
//   3. GET /okul         → 200 (uygulama kabuğu render ediyor)
//   4. GET /api/trpc/me.get → oturumsuz UNAUTHORIZED bekleriz ("API ayakta" kanıtı); 5xx ise FAIL
// Çıkış kodları: 0 = hepsi yeşil · 1 = en az bir adım FAIL · 2 = paymentsFrozen alarmı.
// Kullanım: BASE_URL=https://ornek.teachernow.app node tools/synthetic-probe.mjs

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3010").replace(/\/+$/, "");
const TIMEOUT_MS = 15_000;

let anyFailed = false;
let paymentsFrozen = false;

/** Tek adımı koşar, "OK/FAIL ad — detay (süre)" satırı basar. */
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`OK   ${name} — ${detail} (${Date.now() - t0} ms)`);
  } catch (err) {
    anyFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL ${name} — ${msg} (${Date.now() - t0} ms)`);
  }
}

async function get(path) {
  return fetch(`${BASE_URL}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "teachernow-synthetic-probe" },
  });
}

const startedAt = Date.now();
console.log(`sentetik prob → ${BASE_URL}`);

await step("GET /api/healthz", async () => {
  const res = await get("/api/healthz");
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (200 beklendi)`);
  const body = await res.json();
  if (body.ok !== true || body.db !== "up") {
    throw new Error(`beklenmeyen gövde: ${JSON.stringify(body)}`);
  }
  if (body.paymentsFrozen === true) {
    paymentsFrozen = true;
    return "ok:true db:up — DİKKAT paymentsFrozen:true (para donuk!)";
  }
  return "ok:true db:up paymentsFrozen:false";
});

await step("GET /", async () => {
  const res = await get("/");
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (200 beklendi)`);
  return "HTTP 200";
});

await step("GET /okul", async () => {
  const res = await get("/okul");
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (200 beklendi)`);
  return "HTTP 200";
});

await step("tRPC me.get (oturumsuz)", async () => {
  const res = await get("/api/trpc/me.get");
  if (res.status >= 500) throw new Error(`HTTP ${res.status} — API 5xx veriyor`);
  const text = await res.text();
  // Oturumsuz istekte tRPC'nin düzgün UNAUTHORIZED hatası dönmesi API'ın ayakta,
  // context + DB katmanının çalışır olduğunun kanıtıdır.
  if (!text.includes("UNAUTHORIZED")) {
    throw new Error(`UNAUTHORIZED bekleniyordu; HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return `HTTP ${res.status} — UNAUTHORIZED (beklendiği gibi, API ayakta)`;
});

console.log(`toplam süre: ${Date.now() - startedAt} ms`);

if (paymentsFrozen) {
  console.log("ALARM: paymentsFrozen=true — ödemeler donuk, insan müdahalesi gerekli. exit 2");
  process.exit(2);
}
if (anyFailed) {
  console.log("sonuç: en az bir adım FAIL. exit 1");
  process.exit(1);
}
console.log("sonuç: 4/4 OK");

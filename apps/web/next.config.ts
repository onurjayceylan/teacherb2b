import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Monorepo kökündeki .env tek kaynaktır (DATABASE_URL, BETTER_AUTH_*, STRIPE_*).
// Next yalnız kendi dizinindeki .env'i okuduğu için kökteki dosyayı elle yükleriz.
// Mevcut process env değerleri EZİLMEZ (CI/prod ortam değişkenleri önceliklidir).
function loadRootEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), ".env"),
  ];
  for (const file of candidates) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  // Workspace paketleri kaynak .ts olarak yayınlanır; Next bunları derler.
  transpilePackages: [
    "@teachernow/db",
    "@teachernow/ledger",
    "@teachernow/billing",
    "@teachernow/tenancy",
    "@teachernow/hr",
  ],
  // pg native/koşullu import'ları bundle edilmez; runtime'da node_modules'tan çözülür.
  serverExternalPackages: ["pg"],
  webpack: (config) => {
    // Workspace paketleri NodeNext tarzı "./x.js" import'ları kullanır; kaynak .ts'e eşle.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;

import type { MetadataRoute } from "next";

const SITE_URL = (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3010").replace(/\/+$/, "");

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/giris`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/baslangic`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
  ];
}

import type { MetadataRoute } from "next";

const SITE_URL = (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3010").replace(/\/+$/, "");

// Tanıtım (/) + giriş + başlangıç indekslenir; auth-gated ve tokenlı sayfalar taranmaz.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api", "/okul", "/egitmen", "/ders", "/sinif-dersi", "/join"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}

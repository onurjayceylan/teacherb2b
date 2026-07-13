import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { LangScope } from "./lang-scope";
import { TopNav } from "./top-nav";

const SITE_URL = (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3010").replace(/\/+$/, "");

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Teachernow — okullara native İngilizce konuşma kulübü",
    template: "%s — Teachernow",
  },
  description:
    "Okullar için eğitmen dispatch platformu: doğrulanmış native İngilizce eğitmen havuzu, otomatik ders planlama ve SLA garantili yedekleme — tek panelden. Türkiye, MENA ve ABD.",
  applicationName: "Teachernow",
  authors: [{ name: "Teachernow" }],
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  openGraph: { type: "website", siteName: "Teachernow", locale: "tr_TR", url: SITE_URL },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Mobil tarayıcı chrome'u sistem temasına uysun (denetim G3: dark mode).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f1c" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <div className="shell">
          <TopNav />
          <LangScope>{children}</LangScope>
        </div>
      </body>
    </html>
  );
}

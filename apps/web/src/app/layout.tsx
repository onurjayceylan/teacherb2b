import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { LangScope } from "./lang-scope";
import { TopNav } from "./top-nav";

export const metadata: Metadata = {
  title: { default: "Teachernow", template: "%s — Teachernow" },
  description: "Okullar için eğitmen operasyon platformu — speaking club dersleri, tek panelden.",
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

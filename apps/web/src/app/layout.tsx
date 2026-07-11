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
  themeColor: "#f4f5f9",
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

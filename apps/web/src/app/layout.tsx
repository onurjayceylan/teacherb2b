import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Teachernow",
  description: "Okullar için öğretmen pazaryeri — S1 kabuğu",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <div className="shell">
          <nav className="topbar">
            <a className="brand" href="/">
              Teachernow
            </a>
            <a href="/okul">Okul</a>
            <a href="/kayit">Okul Kaydı</a>
            <a href="/admin">Admin</a>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}

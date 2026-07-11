"use client";

// Kök html lang="tr" — ama eğitmen/ders sayfaları İngilizce. CSS text-transform ve
// ekran okuyucular dil kuralını elementin lang'ından alır (tr'de uppercase i→İ olur;
// "EARNED THİS PERİOD" hatası buradan çıktı). İngilizce rotaları lang="en" kapsamına alır;
// /sinif-dersi iki dilli olduğundan tr kalır.
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

const EN_PREFIXES = ["/egitmen", "/ders/"];

export function LangScope({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const en = EN_PREFIXES.some((p) => pathname.startsWith(p));
  return en ? <div lang="en">{children}</div> : <>{children}</>;
}

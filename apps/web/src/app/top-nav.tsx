"use client";

// Rota-duyarlı üst çubuk (UI denetimi bulgusu): eğitmen/ders token sayfaları İngilizce ve
// bağımsızdır — oralarda Türkçe okul/admin menüsü göstermek hem dil sızıntısı hem gereksiz
// gezinmedir; yalnız marka kalır. Diğer her yerde tam menü.
import Link from "next/link";
import { usePathname } from "next/navigation";

const STANDALONE_PREFIXES = ["/egitmen", "/ders/", "/sinif-dersi/"];

export function TopNav() {
  const pathname = usePathname() ?? "/";
  const standalone = STANDALONE_PREFIXES.some((p) => pathname.startsWith(p));

  return (
    <nav className="topbar">
      <Link className="brand" href="/">
        Teachernow
      </Link>
      {standalone ? null : (
        <>
          <Link href="/okul">Okul</Link>
          <Link href="/baslangic">Başlangıç</Link>
          <Link href="/admin">Admin</Link>
          <Link className="nav-cta" href="/giris">
            Giriş
          </Link>
        </>
      )}
    </nav>
  );
}

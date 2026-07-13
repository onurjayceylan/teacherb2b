// Tanıtım (marketing) landing — SUNUCU bileşeni (SSR): tam HTML crawler'lara ve generative
// arama motorlarına (GEO) sunulur. Kimlik doğrulama ayrı /giris rotasında (client). İçerik
// dürüst ve olgusal tutulur (uydurma sosyal kanıt yok) — hem güven hem GEO için.
import type { Metadata } from "next";
import Link from "next/link";

const BASE_URL = (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3010").replace(/\/+$/, "");
const BRAND = "Teachernow";
const TAGLINE =
  "Özel ve uluslararası okullar için native İngilizce konuşma kulübü derslerini otomatik kuran eğitmen dispatch platformu.";

export const metadata: Metadata = {
  title: "Okullara native İngilizce konuşma kulübü — eğitmen dispatch platformu",
  description:
    "Teachernow, özel ve uluslararası okullara doğrulanmış native İngilizce eğitmen havuzunu toptan sunar: haftalık reçetenizi girin, sistem eğitmeni bulsun, dersi kursun ve ödemeyi döndürsün. SLA garantili, tek panelden. Türkiye, MENA ve ABD.",
  keywords: [
    "okullar için İngilizce eğitmen",
    "native English speaking club",
    "İngilizce konuşma kulübü okul",
    "eğitmen dispatch platformu",
    "özel okul İngilizce programı",
    "uluslararası okul native teacher",
    "B2B ESL platform",
    "speaking club dersleri",
    "Türkiye MENA okul İngilizce",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: BASE_URL,
    siteName: BRAND,
    title: `${BRAND} — okullara native İngilizce konuşma kulübü`,
    description: TAGLINE,
    locale: "tr_TR",
  },
  twitter: {
    card: "summary_large_image",
    title: `${BRAND} — okullara native İngilizce konuşma kulübü`,
    description: TAGLINE,
  },
};

// SSS — hem okul karar-vericisi için hem generative arama motorlarının alıntılaması (FAQPage) için.
const FAQ: { q: string; a: string }[] = [
  {
    q: "Teachernow nedir?",
    a: "Teachernow, özel ve uluslararası okullara doğrulanmış native İngilizce eğitmen havuzunu toptan sunan bir eğitmen dispatch (sevk) platformudur. Okul haftalık ders reçetesini girer; sistem uygun eğitmeni bulur, dersi kurar ve ödemeyi otomatik döndürür. Biz operatör değil, işletim sistemiyiz — öğrenci ilişkisini ve veliye satışı okul yönetir.",
  },
  {
    q: "Nasıl çalışır?",
    a: "Dört adım: (1) Sınıflarınızı ve haftalık ders programınızı (reçete) tek panelden girersiniz. (2) Sistem havuzdan uygun native eğitmeni otomatik bulur ve teklif gönderir. (3) Ders, tokenlı bağlantıyla işlenir; yoklama ve süre kayıt altına alınır. (4) Ödeme ve mutabakat otomatik yürür — arada insan yoktur.",
  },
  {
    q: "Eğitmenler kim?",
    a: "Evrak kontrolü ve görüşme sürecinden geçmiş, doğrulanmış native İngilizce eğitmenlerden oluşan havuzlar. Faz-1 motor havuzu native ESL speaking club eğitmenleridir; ek olarak admissions (üniversite başvuru) stratejisti havuzu bulunur.",
  },
  {
    q: "Bir ders iptal olursa ya da eğitmen gelmezse ne olur?",
    a: "SLA garantisi devreye girer: eğitmen düşerse sistem anında yeni eğitmen arar (backfill). Ders yine de karşılanamazsa o dersin ücreti otomatik iade edilir. Para akışının tamamı çift-kayıt bir defter (ledger) üzerinden yürür; her hareket izlenebilir.",
  },
  {
    q: "Ödeme ve fiyatlandırma nasıl?",
    a: "Okul bir cüzdana bakiye yükler (kart ya da havale); her ders için ücret bloke edilir ve ders tamamlandığında mahsup edilir. Fiyat sınıf/45 dakika başına sabittir, lokasyondan bağımsızdır. Para birimi USD.",
  },
  {
    q: "Hangi okullar ve bölgeler için?",
    a: "Türkiye, MENA (Orta Doğu ve Kuzey Afrika) ve ABD'deki özel ve uluslararası okullar için tasarlandı. Kamu okulu district'leri kapsam dışıdır. Öğrenci verisi (yoklama) rol-bazlı maskeleme ve saklama politikasıyla korunur.",
  },
  {
    q: "Öğrenci ve eğitmen verileri nasıl korunuyor?",
    a: "Eğitmen iletişim bilgisi okula görünmez; öğrenci adları eğitmene maskeli (\"Ad S.\") gider. Roller arası veri erişimi satır-düzeyi güvenlik (RLS) ile ayrılır; ödeme defteri değişmez (append-only) tutulur.",
  },
];

function LandingJsonLd() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${BASE_URL}/#organization`,
        name: BRAND,
        url: BASE_URL,
        description: TAGLINE,
        areaServed: [
          { "@type": "Country", name: "Türkiye" },
          { "@type": "Place", name: "MENA (Orta Doğu ve Kuzey Afrika)" },
          { "@type": "Country", name: "United States" },
        ],
        knowsAbout: [
          "native English speaking club",
          "eğitmen dispatch",
          "okullar için İngilizce programı",
          "ESL",
        ],
      },
      {
        "@type": "SoftwareApplication",
        name: BRAND,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: BASE_URL,
        description: TAGLINE,
        offers: { "@type": "Offer", priceCurrency: "USD", category: "B2B SaaS" },
        audience: { "@type": "Audience", audienceType: "Özel ve uluslararası okullar" },
      },
      {
        "@type": "FAQPage",
        mainEntity: FAQ.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}

export default function HomePage() {
  return (
    <main className="lp">
      <LandingJsonLd />

      {/* ---------- HERO ---------- */}
      <section className="lp-hero">
        <p className="lp-eyebrow">Özel &amp; uluslararası okullar için eğitmen dispatch OS</p>
        <h1>
          Okulunuza <span className="lp-accent">native İngilizce konuşma kulübü</span> — otomatik
          kurulan, garantili dersler
        </h1>
        <p className="lp-sub">
          Haftalık ders reçetenizi girin; Teachernow doğrulanmış native eğitmeni bulsun, dersi
          kursun ve ödemeyi döndürsün. Kayıttan ilk reçeteye <strong>15 dakika</strong>, arada
          insan yok.
        </p>
        <div className="lp-cta-row">
          <Link className="lp-btn" href="/giris">
            Ücretsiz başla
          </Link>
          <Link className="lp-btn ghost" href="#nasil-calisir">
            Nasıl çalışır?
          </Link>
        </div>
        <p className="lp-note muted">
          Türkiye · MENA · ABD özel ve uluslararası okullar · USD · SLA garantili
        </p>
      </section>

      {/* ---------- PROBLEM → ÇÖZÜM ---------- */}
      <section className="lp-section" aria-labelledby="cozum-h">
        <h2 id="cozum-h">Native eğitmen bulmak ve yönetmek okulun işi olmaktan çıkıyor</h2>
        <div className="lp-two">
          <div className="card">
            <h3>Sorun</h3>
            <p className="muted">
              Native İngilizce eğitmeni bulmak, evraklarını denetlemek, takvim kurmak, iptal/telafi
              takibi yapmak ve ödemeyi yürütmek — hepsi okulun sırtında, dağınık ve zaman alıcı.
            </p>
          </div>
          <div className="card">
            <h3>Çözüm</h3>
            <p className="muted">
              Teachernow bu operasyonu bir işletim sistemine devreder: doğrulanmış havuz, otomatik
              sevk, SLA garantili yedekleme ve şeffaf cüzdan. Okul yalnız reçeteyi girer; son
              kilometre (öğrenci ilişkisi, veliye satış) okulda kalır.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- NASIL ÇALIŞIR ---------- */}
      <section className="lp-section" id="nasil-calisir" aria-labelledby="nasil-h">
        <h2 id="nasil-h">Nasıl çalışır?</h2>
        <ol className="lp-steps">
          <li>
            <span className="lp-step-n">1</span>
            <div>
              <h3>Reçeteyi girin</h3>
              <p className="muted">Sınıflarınızı ve haftalık ders programınızı tek panelden ekleyin.</p>
            </div>
          </li>
          <li>
            <span className="lp-step-n">2</span>
            <div>
              <h3>Sistem eğitmeni bulur</h3>
              <p className="muted">
                Havuzdan uygun native eğitmen otomatik seçilir ve teklif gönderilir.
              </p>
            </div>
          </li>
          <li>
            <span className="lp-step-n">3</span>
            <div>
              <h3>Ders işlenir</h3>
              <p className="muted">
                Tokenlı bağlantıyla derse girilir; yoklama ve süre kayıt altına alınır.
              </p>
            </div>
          </li>
          <li>
            <span className="lp-step-n">4</span>
            <div>
              <h3>Ödeme otomatik döner</h3>
              <p className="muted">
                Ücret cüzdandan mahsup edilir, mutabakat çift-kayıt defterinde tutulur.
              </p>
            </div>
          </li>
        </ol>
      </section>

      {/* ---------- ÖZELLİKLER ---------- */}
      <section className="lp-section" aria-labelledby="ozellik-h">
        <h2 id="ozellik-h">Tek panelden tüm operasyon</h2>
        <div className="lp-grid">
          <article className="card">
            <h3>Doğrulanmış eğitmen havuzu</h3>
            <p className="muted">Evrak kontrolü ve görüşmeden geçmiş native İngilizce eğitmenler.</p>
          </article>
          <article className="card">
            <h3>Otomatik sevk (dispatch)</h3>
            <p className="muted">Reçeteniz derslere dönüşür; eğitmen araması kendiliğinden başlar.</p>
          </article>
          <article className="card">
            <h3>SLA garantili yedekleme</h3>
            <p className="muted">
              Eğitmen düşerse sistem yeniden arar; karşılanamayan dersin ücreti iade edilir.
            </p>
          </article>
          <article className="card">
            <h3>Şeffaf cüzdan &amp; defter</h3>
            <p className="muted">
              Bakiye, bloke ve mahsup her adımda görünür; çift-kayıt ledger değişmez.
            </p>
          </article>
          <article className="card">
            <h3>Yoklama &amp; süre kaydı</h3>
            <p className="muted">Ödeme tetiği derse özel olay logudur — dürüst, denetlenebilir.</p>
          </article>
          <article className="card">
            <h3>Veri güvenliği</h3>
            <p className="muted">
              Eğitmen iletişimi gizli, öğrenci adı maskeli; rol-bazlı satır güvenliği (RLS).
            </p>
          </article>
        </div>
      </section>

      {/* ---------- KİMLER İÇİN (GEO) ---------- */}
      <section className="lp-section" aria-labelledby="kimler-h">
        <h2 id="kimler-h">Kimler için?</h2>
        <div className="lp-grid">
          <article className="stat">
            <div className="k">Türkiye</div>
            <p className="muted" style={{ margin: "0.4rem 0 0" }}>
              Özel ve uluslararası okullar, kolejler.
            </p>
          </article>
          <article className="stat">
            <div className="k">MENA</div>
            <p className="muted" style={{ margin: "0.4rem 0 0" }}>
              Orta Doğu ve Kuzey Afrika özel okulları.
            </p>
          </article>
          <article className="stat">
            <div className="k">ABD</div>
            <p className="muted" style={{ margin: "0.4rem 0 0" }}>
              Private ve international schools.
            </p>
          </article>
        </div>
        <p className="muted" style={{ marginTop: "0.9rem" }}>
          Haftalık, tekrarlayan speaking club dersleri; 12 kişilik sınıflar. Para birimi USD.
        </p>
      </section>

      {/* ---------- SSS (FAQPage / GEO) ---------- */}
      <section className="lp-section" aria-labelledby="sss-h">
        <h2 id="sss-h">Sık sorulan sorular</h2>
        <div className="lp-faq">
          {FAQ.map((f) => (
            <details key={f.q} className="card">
              <summary>{f.q}</summary>
              <p className="muted">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ---------- SON CTA ---------- */}
      <section className="lp-section lp-final">
        <div className="card lp-final-card">
          <h2>Okulunuz için ilk reçeteyi 15 dakikada oluşturun</h2>
          <p className="muted">Kredi kartı gerekmez — hesabı açın, sınıflarınızı ekleyin, başlayın.</p>
          <div className="lp-cta-row">
            <Link className="lp-btn" href="/giris">
              Ücretsiz başla
            </Link>
            <Link className="lp-btn ghost" href="/baslangic">
              Başlangıç sihirbazı
            </Link>
          </div>
        </div>
      </section>

      {/* ---------- FOOTER ---------- */}
      <footer className="lp-footer">
        <p>
          <strong>{BRAND}</strong> — okullar için native İngilizce konuşma kulübü dispatch platformu.
        </p>
        <nav aria-label="Alt menü">
          <Link href="/giris">Giriş</Link>
          <Link href="/baslangic">Başlangıç</Link>
          <a href="#nasil-calisir">Nasıl çalışır</a>
          <a href="#sss-h">SSS</a>
        </nav>
      </footer>
    </main>
  );
}

// Nazik 404: var olmayan rotalar için (layout içinde render edilir, nav korunur).
export default function NotFound() {
  return (
    <main>
      <h1>Sayfa bulunamadı</h1>
      <div className="card" style={{ textAlign: "center" }}>
        <p>Aradığınız sayfa taşınmış, adı değişmiş ya da hiç var olmamış olabilir.</p>
        {/* Eğitmen-yüzlü rotalar da bu boundary'ye düşer — kısa İngilizce satır şart. */}
        <p className="muted">Page not found — the link may be outdated or mistyped.</p>
        <p>
          <a href="/">← Ana sayfaya dön</a>
        </p>
        <p className="muted">
          <a href="/okul">Okul paneli</a>
          {" · "}
          <a href="/baslangic">Başlangıç sihirbazı</a>
        </p>
      </div>
    </main>
  );
}

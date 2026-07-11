// Nazik 404: var olmayan rotalar için (layout içinde render edilir, nav korunur).
export default function NotFound() {
  return (
    <main>
      <h1>Sayfa bulunamadı</h1>
      <div className="card">
        <p>Aradığınız sayfa taşınmış, adı değişmiş ya da hiç var olmamış olabilir.</p>
        <p className="muted">
          <a href="/">Ana sayfa</a>
          {" · "}
          <a href="/okul">Okul paneli</a>
          {" · "}
          <a href="/baslangic">Başlangıç sihirbazı</a>
        </p>
      </div>
    </main>
  );
}

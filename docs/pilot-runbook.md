# Pilot Açılış Runbook'u — MEV Koleji · Era Koleji · Dream Big Language Schools

Kural (03-mvp-kapsam): pilot **concierge** yürür ama HER TIKLAMAYI OKUL YAPAR — kurucu yönlendirir, dokunmaz. Takılan her adım ürün açığıdır; not al (funnel kayıtları /admin/metrikler'de).
**G0 hatırlatması:** MEV/Era reşit-olmayan öğrenci içerir — yazılı safeguarding politikası + eğitmen ülke sabıka belgeleri 'verified' olmadan reşit-olmayan içeren İLK ders yapılmaz.

## Hafta 0 — platform hazırlığı (kurucu)
- [ ] Deploy tamam (docs/deploy.md) + `pnpm probe` yeşil + admin atanmış + banka hesapları girili
- [ ] Eğitmen arzı: `/admin/egitmenler` → hrmasterz/CSV toplu import ("Ad;email;TR") → her eğitmene **davet linki** üret ve ilet → eğitmen kendisi: profil + clickwrap sözleşme + evrak beyanları
- [ ] Evrak doğrulama: beyanları kontrol edip 'verified'a çek (5/5 = payout hard-gate açılır; eksikler otomatik hatırlatma kuyruğunda)
- [ ] **İK görüşmeleri** (zorunlu insan adımı): planla → skorla → kabul + havuz ata → eğitmen 'active'
- [ ] Müsaitlik: her aktif eğitmen için haftalık pencereler (+timezone) girili
- [ ] Fiyat kartı kontrol: `/admin` → native_esl $40/45dk (onaylı #12)

## Okul açılışı (okul başına ~1 saat concierge call — Dream Big ilk sıra)
1. **Kayıt:** okul yetkilisi `https://<adres>/` → kayıt ol → `/baslangic` sihirbazı otomatik başlar
2. **Cüzdan:** havale tutarı gir → **TN-referans kodunu** dekonta yazmalarını iste → havale gelince `/admin` → bekleyen top-up'ı **Settle** et (cleared-funds onayı) → okul bakiyeyi görür
3. **Roster:** "Ad Soyad;Sınıf" yapıştır — sayfadaki uyarıyı sesli oku: *yalnız ad-soyad; doğum tarihi/TC/veli bilgisi GİRMEYİN*
4. **İlk reçete:** sınıf + havuz + gün/saat + hafta sayısı → kaydet → slotlar+hold'lar anında; "bloke" uyarısı çıkarsa bakiye/hafta sayısını birlikte ayarlayın
5. Teklifler eğitmenlere düşer (e-posta yokken: `/admin` → teklif linkini eğitmene ilet) → kabul → okul takviminde eğitmen adı

## İlk ders provası (canlı dersten 1 gün önce, test slotuyla)
- [ ] Okul takvimi → slot → **Linkler**: sınıf linki okula (projeksiyon), eğitmen linki eğitmene
- [ ] Eğitmen: `/ders/<token>` → Başlat → yoklama ("Ad S." maskeli) → Bitir → "Ödemeniz işlendi"
- [ ] Kontrol: okul bakiyesi değişmedi (rezervden düştü), `/okul/ekstre`'de hareket, eğitmen panelinde kazanç
- [ ] İtiraz tatbikatı: okul İtiraz aç → admin Reddet/İade — ikisini de bir kez dene

## Haftalık ritim (kurucu, ~30 dk/hafta + İK görüşmeleri)
- [ ] Pzt: `/admin/metrikler` — dosaj gerçekleşme, escalated SAYISI, dispute, funnel
- [ ] Havale mutabakatı: bekleyen top-up'ları settle et
- [ ] 2 haftada bir: `/admin/odemeler` → batch → CSV → Wise'da gönder → "yükledim" → sonuç CSV'sini yapıştır (para ancak burada düşer)
- [ ] Müsaitlik tazeliği: eğitmenleri dürt (gizli-ops #8 — bilinçli insan işi)

## Pilot çıkış kriterleri (03-mvp-kapsam §7)
Dosaj gerçekleşme ≥%90 · escalated vaka raporu ("N'in N'i mekanizmayla çözüldü") · manuel adjustment <%2 · çift ödeme 0 · repeat top-up ≥%60 · **en az 1 okul insan-temassız uçtan uca** (Faz-1 çıkışı) · yapılandırılmış görüşme notları (NPS değil).

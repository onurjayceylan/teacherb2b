-- 0019: Denetim tur 3 [P2] — recordWiseFunding SUNUCU-TARAFI idempotency.
-- Sorun: her recordWiseFunding çağrısı taze uuid'li olay + taze ledger key ürettiği için
-- kurucunun aynı "$X yatırdım"ı iki kez göndermesi (çift-tık / yeniden gönderim) platform_capital'i
-- ve −SUM(wise_clearing) beklenen-bakiye baseline'ını ŞİŞİRİYOR → mutabakat kalıcı sahte fark
-- gösteriyordu (B5'i anlamlı kılan mekanizmayı fat-finger bozabiliyordu).
-- Çözüm: istemci fonlama formuna özel bir idempotency anahtarı (dedup_key) taşır; sunucu bu anahtar
-- üzerinde benzersizlik uygular → aynı anahtarla ikinci çağrı YENİ ledger txn YAZMAZ, mevcut olayı
-- aynen döner. Anahtar opsiyoneldir (NULL'lar benzersizlikten muaf) — eski/servissiz çağrılar bozulmaz.
-- role_platform'un tablo düzeyi INSERT/UPDATE grant'i (0018) yeni kolonu da kapsar.
ALTER TABLE wise_funding_event ADD COLUMN dedup_key text;
CREATE UNIQUE INDEX uq_wise_funding_dedup_key
  ON wise_funding_event (dedup_key) WHERE dedup_key IS NOT NULL;

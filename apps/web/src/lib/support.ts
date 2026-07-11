// P1-H (denetim-3-rol-tur2): tüm ürün yüzeylerinde destek kanalı SIFIRDI. Tek satırlık
// iletişim adresi her yüzeye buradan gelir. Kurucu gerçek adresi NEXT_PUBLIC_SUPPORT_EMAIL
// ile (build zamanı) geçer; yoksa makul yer tutucu.
export const SUPPORT_EMAIL =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "destek@teachernow.co";

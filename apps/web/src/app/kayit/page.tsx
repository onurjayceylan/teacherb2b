// Okul kaydı artık başlangıç sihirbazının 1. adımı — eski linkler kırılmasın diye
// bu rota kalıcı olarak /baslangic'a yönlendirir.
import { redirect } from "next/navigation";

export default function KayitPage(): never {
  redirect("/baslangic");
}

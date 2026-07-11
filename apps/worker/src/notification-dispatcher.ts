// Outbox dispatcher: notification_outbox'taki pending kayıtları e-postaya çevirir.
// - 7 günden eski pending'ler önce 'expired' olur (bayat teklif/davet sonradan gönderilmez).
// - Gönderici yoksa (RESEND_API_KEY tanımsız) kalan pending'lere DOKUNULMAZ — anahtar
//   girilince birikenler akar. Varsa FOR UPDATE SKIP LOCKED ile sırayla gönderilir:
//   başarı → sent + sent_at; hata → attempt++ + last_error, 5. denemede failed.
// PII kuralı: recipient e-postası yalnız gönderim API'sine gider, ASLA loglanmaz.
import type { ActorPool } from "@teachernow/db";

const MAX_ATTEMPTS = 5;
const EXPIRE_AFTER_MS = 7 * 24 * 60 * 60_000;

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export type EmailSender = (msg: EmailMessage) => Promise<void>;

export interface SendPendingOptions {
  /** verilmezse hiçbir pending'e dokunulmaz (skipped sayılır) */
  sender?: EmailSender;
  now?: Date;
  /** tek koşuda işlenecek en çok kayıt (varsayılan 50) */
  batch?: number;
}

export interface SendPendingResult {
  sent: number;
  failed: number;
  expired: number;
  /** sender yokken bekletilen pending sayısı */
  skipped: number;
}

function baseUrl(): string {
  const url =
    process.env.BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3010";
  return url.replace(/\/+$/, "");
}

/** HTML injection'a karşı payload değerleri daima escape edilir. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function usd(cents: unknown): string {
  return `$${(Number(cents ?? 0) / 100).toFixed(2)}`;
}

/** ISO zamanı verilen zone'da Türkçe biçimler; zone/tarih bozuksa ISO'ya düşer. */
function when(iso: unknown, tz: unknown): string {
  const at = new Date(String(iso ?? ""));
  if (Number.isNaN(at.getTime())) return String(iso ?? "");
  try {
    return new Intl.DateTimeFormat("tr-TR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: typeof tz === "string" && tz ? tz : "UTC",
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

/** Eğitmen-yüzlü şablonlar İngilizce: aynı biçim, en-US locale (Türkçe karakter sızmaz). */
function whenEn(iso: unknown, tz: unknown): string {
  const at = new Date(String(iso ?? ""));
  if (Number.isNaN(at.getTime())) return String(iso ?? "");
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: typeof tz === "string" && tz ? tz : "UTC",
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

/** Basit Türkçe şablonlar. Token'lı linkler yalnız burada URL'e dönüşür (BASE_URL). */
export function renderTemplate(
  template: string,
  payload: Record<string, unknown>,
): RenderedEmail {
  switch (template) {
    case "teacher_offer": {
      const at = when(payload["slotStartsAt"], payload["teacherTimezone"]);
      const url = `${baseUrl()}/egitmen/teklif/${String(payload["token"] ?? "")}`;
      return {
        subject: `Yeni ders teklifi — ${at}`,
        html:
          `<p>Merhaba,</p>` +
          `<p>Size yeni bir ders teklifi var: <strong>${esc(at)}</strong>` +
          ` (${esc(payload["durationMin"])} dk` +
          (payload["poolName"] ? `, ${esc(payload["poolName"])}` : "") +
          (payload["schoolName"] ? `, ${esc(payload["schoolName"])}` : "") +
          `).</p>` +
          `<p><a href="${esc(url)}">Teklifi görüntüle ve yanıtla</a></p>` +
          `<p>Teklifler süreli — lütfen en kısa sürede yanıtlayın.</p>`,
      };
    }
    case "teacher_invite": {
      const url = `${baseUrl()}/egitmen/davet/${String(payload["token"] ?? "")}`;
      return {
        subject: "Teachernow eğitmen daveti",
        html:
          `<p>Merhaba ${esc(payload["fullName"])},</p>` +
          `<p>Teachernow eğitmen kadrosuna davetlisiniz. Kaydınızı tamamlamak için:</p>` +
          `<p><a href="${esc(url)}">Daveti aç</a></p>`,
      };
    }
    case "teacher_portal": {
      const url = `${baseUrl()}/egitmen/panel/${String(payload["token"] ?? "")}`;
      return {
        subject: "Teachernow eğitmen paneliniz",
        html:
          `<p>Merhaba ${esc(payload["fullName"])},</p>` +
          `<p>Derslerinizi, kazançlarınızı ve ödemelerinizi buradan izleyebilirsiniz:</p>` +
          `<p><a href="${esc(url)}">Eğitmen panelini aç</a></p>` +
          `<p>Bu bağlantı kişiseldir — lütfen kimseyle paylaşmayın.</p>`,
      };
    }
    case "school_sla_escalated": {
      const at = when(payload["slotStartsAt"], "Europe/Istanbul");
      const refunded = Number(payload["refundedCents"] ?? 0);
      return {
        subject: `Ders ataması yapılamadı — ${esc(payload["schoolName"])}`,
        html:
          `<p>Merhaba,</p>` +
          `<p><strong>${esc(payload["className"])}</strong> sınıfının ` +
          `<strong>${esc(at)}</strong> dersine eğitmen atanamadı; ekibimiz devrede.</p>` +
          (refunded > 0
            ? `<p>SLA sözümüz gereği ders ücreti (${esc(usd(refunded))}) bakiyenize iade edildi.</p>`
            : "") +
          `<p>Sorularınız için bize ulaşabilirsiniz.</p>`,
      };
    }
    case "school_low_balance": {
      return {
        subject: `Düşük bakiye uyarısı — ${esc(payload["schoolName"])}`,
        html:
          `<p>Merhaba,</p>` +
          `<p>Okul bakiyeniz (${esc(usd(payload["balanceCents"]))}) önümüzdeki 7 günün planlı ` +
          `ders taahhüdünü (${esc(usd(payload["committed7dCents"]))}) karşılamıyor.</p>` +
          `<p>Derslerin kesintisiz devam etmesi için lütfen bakiye yükleyin.</p>`,
      };
    }
    case "teacher_doc_reminder": {
      return {
        subject: "Evrak hatırlatması — Teachernow",
        html:
          `<p>Merhaba,</p>` +
          `<p>Eğitmen dosyanızda eksik ya da reddedilmiş evrak bulunuyor. Ödemelerin ` +
          `açılabilmesi için lütfen evraklarınızı tamamlayın.</p>`,
      };
    }
    // Eğitmen-yüzlü şablonlar İNGİLİZCE (Tur A kararı) — okul-yüzlüler Türkçe kalır.
    case "teacher_slot_cancelled": {
      const at = whenEn(payload["slotStartsAt"], payload["teacherTimezone"]);
      return {
        subject: `Lesson cancelled — ${at}`,
        html:
          `<p>Hello,</p>` +
          `<p>Your lesson on <strong>${esc(at)}</strong>` +
          (payload["schoolName"] ? ` with ${esc(payload["schoolName"])}` : "") +
          ` has been cancelled by the school.</p>` +
          (payload["lateCancel"]
            ? `<p>Because this was a late cancellation, you are paid 50% of your lesson fee for this slot.</p>`
            : "") +
          `<p>No action is needed on your side.</p>`,
      };
    }
    case "teacher_interview_scheduled": {
      const at = whenEn(payload["scheduledAt"], payload["teacherTimezone"]);
      const meetingUrl = typeof payload["meetingUrl"] === "string" ? payload["meetingUrl"] : "";
      return {
        subject: `Your Teachernow interview is scheduled — ${at}`,
        html:
          `<p>Hello,</p>` +
          `<p>Your Teachernow interview is scheduled for <strong>${esc(at)}</strong>.</p>` +
          (meetingUrl ? `<p><a href="${esc(meetingUrl)}">Join the interview</a></p>` : "") +
          `<p>Please be on time - good luck!</p>`,
      };
    }
    case "school_dispute_resolved": {
      const at = when(payload["slotStartsAt"], "Europe/Istanbul");
      const refunded = payload["outcome"] === "refunded";
      return {
        subject: `Ders itirazınız sonuçlandı — ${esc(payload["schoolName"])}`,
        html:
          `<p>Merhaba,</p>` +
          `<p><strong>${esc(at)}</strong> dersi için açtığınız itiraz sonuçlandı.</p>` +
          (refunded
            ? `<p>Sonuç: itirazınız kabul edildi — ders ücreti` +
              (payload["refundedCents"] ? ` (${esc(usd(payload["refundedCents"]))})` : "") +
              ` bakiyenize iade edildi.</p>`
            : `<p>Sonuç: itirazınız reddedildi — kayıtlar dersin verildiğini doğruladı; ` +
              `ödeme geçerli kalır.</p>`) +
          `<p>Sorularınız için bize ulaşabilirsiniz.</p>`,
      };
    }
    case "school_topup_settled": {
      return {
        subject: `Bakiye yüklemeniz onaylandı — ${esc(usd(payload["amountCents"]))}`,
        html:
          `<p>Merhaba,</p>` +
          `<p>Banka havaleniz` +
          (payload["referenceCode"] ? ` (referans: <strong>${esc(payload["referenceCode"])}</strong>)` : "") +
          ` onaylandı; ${esc(usd(payload["amountCents"]))} okul bakiyenize eklendi.</p>` +
          `<p>Güncel bakiyenizi panelinizden görebilirsiniz.</p>`,
      };
    }
    case "platform_alert": {
      const checks = Array.isArray(payload["checks"]) ? payload["checks"] : [];
      if (payload["kind"] === "chargeback") {
        // Kart itirazı alarmı (0014): para OTOMATİK düzeltilmez — reversal admin'den atılır.
        return {
          subject: "PLATFORM ALARM — kart itirazı (chargeback)",
          html:
            `<p>Stripe kart itirazı bildirimi: <strong>${esc(checks.join(", "))}</strong></p>` +
            `<p>Detay: ${esc(payload["detail"])}</p>` +
            `<p>Para düzeltmesi otomatik yapılmaz — gerekiyorsa reversal admin panelinden atılır.</p>`,
        };
      }
      return {
        subject: "PLATFORM ALARM — sentinel kill-switch devrede",
        html:
          `<p>Invariant sentinel CRITICAL ihlal buldu; <strong>payments_frozen</strong> devreye alındı.</p>` +
          `<p>Kontroller: ${esc(checks.join(", "))}</p>` +
          `<p>Detay: ${esc(payload["detail"])}</p>` +
          `<p>Ödemeler insan müdahalesine kadar donuk kalır.</p>`,
      };
    }
    default:
      throw new Error(`renderTemplate: bilinmeyen şablon: ${template}`);
  }
}

/**
 * Resend REST göndericisi (SDK'sız — node fetch yeterli). Yanıt 2xx değilse hata fırlatır;
 * dispatcher hatayı attempt/last_error olarak işler.
 */
export function defaultResendSender(apiKey: string): EmailSender {
  return async (msg) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM ?? "Teachernow <noreply@teachernow.app>",
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`resend: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
  };
}

export async function sendPendingNotifications(
  pool: ActorPool,
  opts: SendPendingOptions = {},
): Promise<SendPendingResult> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 50;
  const sender = opts.sender;

  return pool.withPlatform(async (db) => {
    // 7 günden eski pending'ler bayat: gönderilmeden expired'a çekilir.
    const expiredRes = await db.query(
      `UPDATE notification_outbox
          SET status = 'expired', last_error = 'bayat: 7 günden eski pending'
        WHERE status = 'pending' AND created_at < $1`,
      [new Date(now.getTime() - EXPIRE_AFTER_MS)],
    );
    const expired = expiredRes.rowCount ?? 0;

    if (!sender) {
      // Anahtar yok → pending'lere dokunma; kayıtlar birikir, anahtar girilince akar.
      const pending = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM notification_outbox WHERE status = 'pending'",
      );
      return { sent: 0, failed: 0, expired, skipped: Number(pending.rows[0]?.n ?? 0) };
    }

    // SKIP LOCKED: eşzamanlı ikinci dispatcher aynı kayıtları kapmaz.
    const rows = await db.query<{
      id: string;
      recipient_email: string;
      template: string;
      payload: Record<string, unknown>;
      attempt: number;
    }>(
      `SELECT id, recipient_email, template, payload, attempt
         FROM notification_outbox
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batch],
    );

    let sent = 0;
    let failed = 0;
    for (const row of rows.rows) {
      try {
        const rendered = renderTemplate(row.template, row.payload);
        await sender({ to: row.recipient_email, subject: rendered.subject, html: rendered.html });
        await db.query(
          `UPDATE notification_outbox
              SET status = 'sent', sent_at = $2, last_error = NULL
            WHERE id = $1`,
          [row.id, now],
        );
        sent += 1;
      } catch (err) {
        const attempt = row.attempt + 1;
        const exhausted = attempt >= MAX_ATTEMPTS;
        if (exhausted) failed += 1;
        await db.query(
          `UPDATE notification_outbox
              SET attempt = $2, last_error = $3, status = $4
            WHERE id = $1`,
          [
            row.id,
            attempt,
            err instanceof Error ? err.message : String(err),
            exhausted ? "failed" : "pending",
          ],
        );
      }
    }
    return { sent, failed, expired, skipped: 0 };
  });
}

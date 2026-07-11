// Join token'ları: video odasına girişin login'siz yetki kapısı. DB'siz çalışır —
// HMAC-SHA256 imza, secret parametre olarak gelir (web BETTER_AUTH_SECRET verir).
// Format: base64url("slotId.role.exp.hmacSHA256hex"); exp epoch saniyedir.
// slotId uuid olduğundan '.' içermez — nokta ayracı güvenli.
import { createHmac, timingSafeEqual } from "node:crypto";

export type JoinRole = "teacher" | "class";

export interface JoinTokenInput {
  slotId: string;
  role: JoinRole;
  expiresAt: Date;
}

export interface JoinTokenClaims {
  slotId: string;
  role: JoinRole;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signJoinToken(input: JoinTokenInput, secret: string): string {
  const exp = Math.floor(input.expiresAt.getTime() / 1000);
  const payload = `${input.slotId}.${input.role}.${exp}`;
  const raw = `${payload}.${hmacHex(secret, payload)}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/**
 * İmza + süre kontrolü; her hatada null (çağırana neden sızdırılmaz).
 * İmza karşılaştırması timing-safe — token tahmini yan kanaldan hızlanamaz.
 */
export function verifyJoinToken(token: string, secret: string): JoinTokenClaims | null {
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const parts = decoded.split(".");
  if (parts.length !== 4) return null;
  const [slotId, role, expStr, sig] = parts;
  if (!slotId || !expStr || !sig) return null;
  if (role !== "teacher" && role !== "class") return null;
  const exp = Number(expStr);
  if (!Number.isInteger(exp)) return null;

  const expected = hmacHex(secret, `${slotId}.${role}.${expStr}`);
  const sigBuf = Buffer.from(sig, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  if (exp * 1000 <= Date.now()) return null; // süresi dolmuş
  return { slotId, role };
}

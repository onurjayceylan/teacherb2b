// @teachernow/sessions — S4: oturum yaşam döngüsü, settle (hold→pay bölüşümü),
// dispute (ters kayıtla düzeltme), join/portal token'ları.
// Boundary kuralı: bu modül YALNIZ @teachernow/db'ye bağımlıdır; para yazımı
// SECURITY DEFINER SQL fonksiyonlarıyla yapılır (bkz. ledger.ts).
export {
  signJoinToken,
  verifyJoinToken,
  type JoinRole,
  type JoinTokenClaims,
  type JoinTokenInput,
} from "./tokens.js";
export {
  ensureSessionForSlot,
  recordEvent,
  startSession,
  markAttendance,
  endSession,
  type AttendanceEntry,
  type EndSessionResult,
  type EnsureSessionResult,
  type RecordEventInput,
  type SessionEventKind,
  type SessionEventRole,
  type StartSessionResult,
} from "./lifecycle.js";
export { settleSession, type SettleSessionResult } from "./settle.js";
export {
  openDispute,
  resolveDispute,
  type OpenDisputeInput,
  type ResolveDisputeInput,
  type ResolveDisputeResult,
} from "./disputes.js";
export {
  createPortalToken,
  getTeacherByPortalToken,
  revokePortalTokens,
  type CreatePortalTokenInput,
  type PortalTeacher,
} from "./portal.js";

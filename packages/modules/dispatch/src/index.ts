// @teachernow/dispatch — S3 dispatch çekirdeği: zaman matematiği, plan materializasyonu,
// eşleştirme/teklif yaşam döngüsü ve iptal/no-show matrisi. Yalnız @teachernow/db'ye bağımlıdır;
// para SQL fonksiyonları (post_ledger_txn / ensure_ledger_account) doğrudan çağrılır.
export { occurrenceToUtc, utcToZoneMinutes, type UtcWindow, type ZoneMinutes } from "./time.js";
export {
  materializePlans,
  type MaterializeOptions,
  type MaterializeResult,
} from "./materializer.js";
export {
  findCandidates,
  offerNext,
  acceptOffer,
  declineOffer,
  expireStaleOffers,
  type Candidate,
  type OfferResult,
  type OfferNextOptions,
  type AcceptOfferResult,
  type DeclineOfferResult,
  type ExpireResult,
} from "./matcher.js";
export {
  cancelBySchool,
  teacherDrop,
  teacherNoShow,
  type CancelBySchoolInput,
  type CancelBySchoolResult,
  type TeacherDropInput,
  type TeacherDropResult,
  type TeacherNoShowInput,
  type TeacherNoShowResult,
} from "./cancellations.js";
export {
  sweepBackfill,
  type SweepBackfillOptions,
  type SweepBackfillResult,
} from "./backfill.js";
export { getSlot, getSlotForUpdate, type SlotRow } from "./slots.js";

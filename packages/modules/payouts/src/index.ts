// @teachernow/payouts — S5: Wise-manuel payout akışı. Ledger-otomatik, yürütme-insan,
// mutabakat-dosyayla: createBatch alacakları toplar, exportBatchCsv dosyayı üretir,
// markBatchSubmitted insan beyanını kaydeder, importResults sonuç dosyasını işler
// (para YALNIZ burada, 'paid' onayıyla ledger'a yazılır). Yalnız @teachernow/db'ye bağımlıdır.
export {
  createBatch,
  exportBatchCsv,
  markBatchSubmitted,
  type CreateBatchInput,
  type CreateBatchResult,
  type HeldTeacher,
  type MarkBatchSubmittedResult,
} from "./batches.js";
export {
  importResults,
  type ImportResultRow,
  type ImportResultsResult,
} from "./results.js";
export {
  listOpen,
  getTeacherPayouts,
  type OpenPayoutRow,
  type TeacherPayoutRow,
} from "./queries.js";

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
  teachersMissingPayoutDetails,
  type OpenPayoutRow,
  type TeacherPayoutRow,
  type TeacherMissingPayoutDetailsRow,
} from "./queries.js";
export {
  recordWiseFunding,
  listWiseFundings,
  type RecordWiseFundingInput,
  type RecordWiseFundingResult,
  type WiseFundingRow,
} from "./funding.js";

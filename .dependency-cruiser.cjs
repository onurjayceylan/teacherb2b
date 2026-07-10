/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Döngüsel bağımlılık yasak.",
      from: {},
      to: { circular: true },
    },
    {
      name: "apps-not-imported",
      severity: "error",
      comment: "apps/** paketlerden import edebilir; packages/** apps/**'i import edemez.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "db-internals",
      severity: "error",
      comment:
        "testdb.ts yalnız test dosyalarından (*.test.ts veya test/ dizini) ya da packages/db içinden import edilebilir.",
      from: {
        pathNot: ["\\.test\\.ts$", "(^|/)test/", "^packages/db/"],
      },
      to: { path: "^packages/db/src/testdb\\.ts$" },
    },
    {
      name: "ledger-katmani",
      severity: "error",
      comment:
        "packages/modules/ledger yalnız @teachernow/db'ye bağımlı olabilir — diğer modülleri import edemez.",
      from: { path: "^packages/modules/ledger/" },
      to: {
        path: "^packages/modules/",
        pathNot: "^packages/modules/ledger/",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
    // Kaynak .ts import'larını (derleme öncesi) çözebilmek için:
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types"],
    },
  },
};

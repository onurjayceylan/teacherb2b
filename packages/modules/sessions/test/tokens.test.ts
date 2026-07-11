// Join token'ları DB'siz test edilir: round-trip, bozuk imza, yanlış secret, süre dolumu.
import { expect, test } from "vitest";
import { signJoinToken, verifyJoinToken } from "../src/tokens.js";

const SECRET = "test-secret-cok-gizli";
const SLOT_ID = "1b671a64-40d5-491e-99b0-da01ff1f3341";

test("round-trip: imzalanan token aynı secret'la çözülür", async () => {
  const token = signJoinToken(
    { slotId: SLOT_ID, role: "teacher", expiresAt: new Date(Date.now() + 60_000) },
    SECRET,
  );
  expect(verifyJoinToken(token, SECRET)).toEqual({ slotId: SLOT_ID, role: "teacher" });

  const classToken = signJoinToken(
    { slotId: SLOT_ID, role: "class", expiresAt: new Date(Date.now() + 60_000) },
    SECRET,
  );
  expect(verifyJoinToken(classToken, SECRET)).toEqual({ slotId: SLOT_ID, role: "class" });
});

test("bozuk imza / yanlış secret / oynanmış payload → null", async () => {
  const token = signJoinToken(
    { slotId: SLOT_ID, role: "teacher", expiresAt: new Date(Date.now() + 60_000) },
    SECRET,
  );

  // yanlış secret
  expect(verifyJoinToken(token, "baska-secret")).toBeNull();

  // imzanın son karakteri değiştirilir
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const flipped = decoded.slice(0, -1) + (decoded.endsWith("0") ? "1" : "0");
  expect(verifyJoinToken(Buffer.from(flipped, "utf8").toString("base64url"), SECRET)).toBeNull();

  // rol oynanır (imza eski payload'a ait kalır)
  const parts = decoded.split(".");
  const tampered = [parts[0], "class", parts[2], parts[3]].join(".");
  expect(verifyJoinToken(Buffer.from(tampered, "utf8").toString("base64url"), SECRET)).toBeNull();

  // düpedüz çöp
  expect(verifyJoinToken("hic-token-degil", SECRET)).toBeNull();
  expect(verifyJoinToken("", SECRET)).toBeNull();
});

test("süresi dolmuş token → null", async () => {
  const token = signJoinToken(
    { slotId: SLOT_ID, role: "teacher", expiresAt: new Date(Date.now() - 1_000) },
    SECRET,
  );
  expect(verifyJoinToken(token, SECRET)).toBeNull();
});

// Sağlık ucu: DB ping + payments_frozen değeri. İzleme/uptime kontrolleri için.
import { isPaymentsFrozen } from "@teachernow/ledger";
import { getPool } from "../../../lib/pool";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const paymentsFrozen = await getPool().withPlatform(async (db) => {
      await db.query("SELECT 1");
      return isPaymentsFrozen(db);
    });
    return Response.json({ ok: true, db: "up", paymentsFrozen });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}

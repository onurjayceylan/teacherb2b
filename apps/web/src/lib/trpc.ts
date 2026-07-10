// tRPC istemcisi (vanilla): httpBatchLink + superjson. En basit çalışan yapı —
// react-query katmanı S1'de gerekmedi; sayfalar doğrudan trpc.*.query/mutate çağırır.
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../server/routers/_app";

export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
});

/** Hata nesnesinden kullanıcıya gösterilebilir Türkçe-uyumlu mesaj çıkarır. */
export function errorMessage(err: unknown): string {
  if (err instanceof TRPCClientError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Cent → "12.34 USD" biçimi (bigint güvenliği: değerler cent cinsinden tam sayı). */
export function formatCents(cents: number, currency = "USD"): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

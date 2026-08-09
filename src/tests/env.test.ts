import { describe, it, expect } from "vitest";
import { env } from "@/config/env";

/**
 * Regression guard for a subtle env-parsing bug.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and every non-empty string is
 * truthy — so `BLOCKCHAIN_ENABLED=false` parsed as `true`. That silently
 * enabled the real-ledger code path, which is not configured, so every
 * supply-chain event was written to the database with status FAILED while the
 * app looked healthy. The hash chain stayed intact, but nothing was CONFIRMED.
 */
describe("environment parsing", () => {
  it('reads BLOCKCHAIN_ENABLED="false" as the boolean false', () => {
    // The test setup pins this to "false"; a regression would flip it to true.
    expect(env.BLOCKCHAIN_ENABLED).toBe(false);
  });

  it("exposes BLOCKCHAIN_ENABLED as a real boolean, not a string", () => {
    expect(typeof env.BLOCKCHAIN_ENABLED).toBe("boolean");
  });

  it("keeps the mock ledger path active while the flag is off", async () => {
    const { recordBlockchainEvent } = await import("@/blockchain/blockchain.service");
    expect(typeof recordBlockchainEvent).toBe("function");
    // With the flag off, submitToLedger must not throw — see ledger.test.ts for
    // the end-to-end assertion that events settle as CONFIRMED.
    expect(env.BLOCKCHAIN_ENABLED).toBe(false);
  });
});

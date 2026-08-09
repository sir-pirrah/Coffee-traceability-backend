/**
 * Shared helpers for DB-backed suites.
 *
 * The smoke tests fall into two groups:
 *   - pure HTTP/authz checks that need no database (health, 401s, validation)
 *   - lifecycle checks that need real rows (batch flow, chain verify, trigger)
 *
 * The second group uses `describeIfDb` so a checkout without Postgres — or a CI
 * job whose service container failed — reports *skipped* rather than a wall of
 * connection errors that would bury real failures.
 *
 * `setup.ts` performs the connection probe before any test file is collected
 * and records the result in `process.env.TEST_DB_READY`, so the skip decision
 * is available synchronously here (Vitest needs it at collection time).
 */
import { describe } from "vitest";
import { prisma } from "@/repositories/prisma.client";
import { runAsSystem } from "@/repositories/dbContext";

export const hasDb = (): boolean => process.env.TEST_DB_READY === "1";

export const describeIfDb = describe.skipIf(!hasDb());

/**
 * Runs fixture setup, teardown, or a direct database assertion with row-level
 * security bypassed.
 *
 * Test code runs outside the request pipeline, so no `dbContextScope` ever opens
 * a store for it and every query would otherwise carry an empty context — which
 * the policies correctly read as "matches nothing", failing inserts with
 * `42501` and returning zero rows on reads. Fixtures are privileged setup in the
 * same sense the seed script is, so they get the same treatment.
 *
 * Deliberately NOT applied to the requests under test: those go through
 * supertest and the real middleware stack, so they carry the caller's true
 * identity and are governed by the policies exactly as in production. Wrapping
 * them here would test nothing.
 */
export function asSystem<T>(fn: () => Promise<T>): () => Promise<T> {
  return () => runAsSystem(fn);
}

export { prisma };

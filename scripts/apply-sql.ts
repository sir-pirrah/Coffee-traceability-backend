/**
 * Applies a raw SQL migration file using the application's own Prisma
 * connection. Used because `prisma migrate deploy` cannot parse this
 * project's DATABASE_URL (the password contains an unencoded `@`), while
 * the Prisma client itself connects without issue.
 *
 *   npx tsx scripts/apply-sql.ts prisma/migrations/<name>/migration.sql
 */
import fs from "node:fs";
import { prisma } from "../src/repositories/prisma.client";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: tsx scripts/apply-sql.ts <path-to-sql>");

  const sql = fs.readFileSync(file, "utf8");
  await prisma.$executeRawUnsafe(sql);
  console.log("Migration applied OK:", file);
}

main()
  .catch((err) => {
    console.error("FAILED:", (err as Error).message.split("\n").slice(0, 8).join("\n"));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

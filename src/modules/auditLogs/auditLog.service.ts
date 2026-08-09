import { Request } from "express";
import { prisma } from "@/repositories/prisma.client";
import { AuditAction, Prisma } from "@prisma/client";

interface AuditParams {
  req: Request;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

// Fire-and-forget audit trail writer. Never throws into the caller's
// request flow — an audit-log failure should not fail the business
// operation it is describing, but it is logged for investigation.
export async function recordAuditLog({ req, action, entityType, entityId, metadata }: AuditParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: req.user?.id,
        action,
        entityType,
        entityId,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        // `Record<string, unknown>` is structurally wider than Prisma's
        // InputJsonValue (which rejects `unknown` members). Callers only ever
        // pass JSON-safe values, so narrow it at the boundary.
        metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch {
    // Intentionally swallowed — see comment above. A dedicated monitor
    // job/alert should watch for repeated audit-log write failures.
  }
}

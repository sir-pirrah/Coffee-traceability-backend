import PDFDocument from "pdfkit";
import type { Response } from "express";
import type { BatchTraceabilitySheet } from "./report.service";

/**
 * Streams a Batch Traceability Sheet (Report #3) as a PDF straight into the
 * Express response. The caller must have already set the response headers
 * (Content-Type / Content-Disposition) before invoking this — the doc pipes
 * itself into `res` and ends the stream when the layout is complete.
 *
 * Layout is intentionally plain: an identity block, the chain-verified badge,
 * then one table per lifecycle stage (deliveries → processing → warehouse →
 * sales). No prices or PII beyond farmer names (audit-facing sheet).
 */

const BRAND_GREEN = "#0B3D20";
const MUTED = "#555555";
const RED = "#B00020";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.split("T")[0];
}

export function buildTraceabilitySheetPdf(sheet: BatchTraceabilitySheet, res: Response): void {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(res);

  // Title
  doc.fillColor(BRAND_GREEN).fontSize(20).text("Batch Traceability Sheet", { align: "left" });
  doc.moveDown(0.3);
  doc.fillColor(MUTED).fontSize(10).text(`Generated ${fmtDate(sheet.generatedAt)}`);
  doc.moveDown(1);

  // Identity block
  doc.fillColor("#000000").fontSize(12);
  const identity: [string, string][] = [
    ["Batch code", sheet.batchCode],
    ["Status", sheet.status],
    ["Origin region", sheet.originRegion ?? "—"],
    ["Harvest season", sheet.harvestSeason ?? "—"],
    ["Total weight", `${sheet.totalWeightKg} kg`],
    ["Cooperative", `${sheet.cooperative.name} (${sheet.cooperative.county})`],
  ];
  for (const [label, value] of identity) {
    doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
    doc.font("Helvetica").text(value);
  }
  doc.moveDown(0.8);

  // Blockchain badge
  if (sheet.blockchain.chainValid) {
    doc
      .fillColor(BRAND_GREEN)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`✓ Blockchain verified — ${sheet.blockchain.confirmedEvents} confirmed event(s), chain intact`);
  } else {
    doc
      .fillColor(RED)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`✗ Blockchain integrity BROKEN${sheet.blockchain.brokenAt ? ` at ${sheet.blockchain.brokenAt}` : ""}`);
  }
  doc.fillColor("#000000").font("Helvetica");
  doc.moveDown(1);

  const section = (title: string): void => {
    doc.moveDown(0.5);
    doc.fillColor(BRAND_GREEN).font("Helvetica-Bold").fontSize(13).text(title);
    doc.fillColor("#000000").font("Helvetica").fontSize(10);
    doc.moveDown(0.3);
  };

  const line = (text: string): void => {
    doc.text(text, { indent: 10 });
  };

  // Deliveries
  section("Contributing Deliveries");
  if (sheet.deliveries.length === 0) {
    doc.fillColor(MUTED).text("No deliveries recorded.", { indent: 10 }).fillColor("#000000");
  } else {
    for (const d of sheet.deliveries) {
      line(`${fmtDate(d.deliveryDate)} — ${d.farmerName} — ${d.weightKg} kg — grade ${d.qualityGrade ?? "Ungraded"}`);
    }
  }

  // Processing
  section("Processing Steps");
  if (sheet.processing.length === 0) {
    doc.fillColor(MUTED).text("No processing records.", { indent: 10 }).fillColor("#000000");
  } else {
    for (const p of sheet.processing) {
      const out = p.outputWeightKg !== null ? `${p.outputWeightKg} kg out` : "in progress";
      line(`${fmtDate(p.startDate)} → ${fmtDate(p.endDate)} — ${p.method} — ${out}`);
    }
  }

  // Warehouse
  section("Warehouse History");
  if (sheet.warehouseHistory.length === 0) {
    doc.fillColor(MUTED).text("No warehouse records.", { indent: 10 }).fillColor("#000000");
  } else {
    for (const w of sheet.warehouseHistory) {
      const loc = w.location ? ` (${w.location})` : "";
      const removed = w.removedAt ? `removed ${fmtDate(w.removedAt)}` : "currently stored";
      line(`${w.warehouseName}${loc} — stored ${fmtDate(w.storedAt)}, ${removed}`);
    }
  }

  // Sales
  section("Sale Status");
  if (sheet.sales.length === 0) {
    doc.fillColor(MUTED).text("No sale/transfer records.", { indent: 10 }).fillColor("#000000");
  } else {
    for (const s of sheet.sales) {
      const buyer = s.buyerName ?? "Unknown buyer";
      const country = s.country ? `, ${s.country}` : "";
      line(`${fmtDate(s.transferredAt)} — ${buyer}${country} — ${s.status}`);
    }
  }

  doc.end();
}

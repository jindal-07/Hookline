// Shared route helpers (query schemas + export responder).
import { z } from "zod";
import { listVideos, exportRows, getDetailedExport } from "../services/queries.js";
import { toCsv, toXlsx } from "../services/export/Exporter.js";

const csvOf = (values) => z.string().regex(new RegExp(`^(${values.join("|")})(,(${values.join("|")}))*$`)).optional();
export const videoListQuery = z.object({
  batchId: z.string().uuid().optional(),
  status: csvOf(["PENDING", "DOWNLOADING", "AUDIO_EXTRACTION", "ANALYSIS_PENDING", "TRANSCRIBING", "SCREENPLAY_ANALYSIS", "MATCHING", "GENERATION_PENDING", "SCRIPT_GENERATION", "COMPLETED", "INCONCLUSIVE", "SKIPPED_LOW_SCORE", "FAILED", "CANCELLED"]),
  generationStatus: csvOf(["NOT_ELIGIBLE", "PENDING", "RUNNING", "AWAITING_MANUAL", "COMPLETED", "REJECTED", "FAILED", "DISABLED"]),
  matchStatus: csvOf(["MATCHED", "PARTIAL", "MISMATCHED", "INCONCLUSIVE"]),
  category: z.string().max(128).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  threshold: z.enum(["above", "below"]).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["row", "score"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function sendExport(res, { batchId, name, format, scope, ids, detailed }) {
  if (detailed) {
    const rows = await exportRows({ batchId, scope, ids });
    const vids = await listVideos({ batchId, ids: scope === "selected" ? ids : undefined, matchStatus: scope === "qualifying" ? "MATCHED" : undefined, limit: 1000 });
    res.setHeader("Content-Disposition", `attachment; filename="${name}-detailed.json"`);
    return res.json({ exported_at: new Date().toISOString(), count: rows.length, videos: await getDetailedExport(vids.items.map(v => v.id)) });
  }
  const rows = await exportRows({ batchId, scope, ids });
  if (format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="${name}.json"`);
    return res.json({ exported_at: new Date().toISOString(), count: rows.length, rows });
  }
  if (format === "xlsx") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
    return res.send(toXlsx(rows));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
  return res.send(toCsv(rows));
}

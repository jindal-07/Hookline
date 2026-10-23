// Confirm-and-delete for batches, shared by the Batches list and the batch page.
import { useCallback } from "react";
import { api } from "../services/api.js";
import { useConfirm, useToast } from "../components/controls.jsx";

export const canDeleteBatch = (b) => ["DRAFT", "COMPLETED", "CANCELLED"].includes(b.status);

export function useBatchDeletion() {
  const confirm = useConfirm();
  const toast = useToast();

  /** Delete one batch after confirmation. Resolves true when deleted. */
  const deleteOne = useCallback(async (b) => {
    const ok = await confirm({
      title: `Delete "${b.filename}"?`,
      body: `This permanently removes the batch and its ${b.total_videos} video(s): transcripts, analyses, matches${b.purpose === "dataset" ? "" : " and per-video scripts"}. ` +
        (b.purpose === "dataset" ? "Datasets already built keep their numbers, but future rebuilds won't include these videos. " : "") +
        "API usage history is kept. This can't be undone.",
      confirmLabel: "Delete batch",
      danger: true,
    });
    if (!ok) return false;
    try {
      const r = await api.deleteBatch(b.id);
      toast(`Deleted "${r.filename}" (${r.videos} videos)`, "success");
      return true;
    } catch (e) { toast(e.message, "error"); return false; }
  }, [confirm, toast]);

  /** Delete every cancelled batch after confirmation. */
  const deleteCancelled = useCallback(async (batches) => {
    const n = batches.length, videos = batches.reduce((t, b) => t + (b.total_videos || 0), 0);
    const ok = await confirm({
      title: `Delete ${n} cancelled batch${n === 1 ? "" : "es"}?`,
      body: `This permanently removes ${n} cancelled batch${n === 1 ? "" : "es"} and their ${videos.toLocaleString()} video row(s), with anything analysed for them. API usage history is kept. This can't be undone.`,
      confirmLabel: "Delete cancelled",
      danger: true,
    });
    if (!ok) return false;
    try {
      const r = await api.deleteCancelledBatches();
      toast(`Deleted ${r.deleted} cancelled batch${r.deleted === 1 ? "" : "es"}`, "success");
      return true;
    } catch (e) { toast(e.message, "error"); return false; }
  }, [confirm, toast]);

  return { deleteOne, deleteCancelled };
}

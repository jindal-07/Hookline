import { useMemo, useState } from "react";
import { api, downloads, downloadFile } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, Loading, ErrorState, Badge } from "../components/ui.jsx";
import { Menu, useToast } from "../components/controls.jsx";
import { VideoTable, Filters, EMPTY_FILTERS } from "../components/VideoTable.jsx";

export default function Videos() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selected, setSelected] = useState(new Set());
  const toast = useToast();
  const batches = useApi(() => api.batches());
  const videos = useApi(() => api.videos({ ...filters, limit: 500 }), [JSON.stringify(filters)]);
  const refresh = useDebounced(() => videos.reload({ silent: true }), 800);
  useEvents(refresh);
  const categories = useMemo(() => [...new Set((videos.data?.items || []).map(v => v.category).filter(Boolean))].sort(), [videos.data]);
  const sel = [...selected];
  const exportAs = (opts) => downloadFile(downloads.selectedExport(sel, opts)).catch(e => toast(e.message, "error"));

  return (
    <>
      <PageHeader
        title="Videos"
        subtitle="Every video across all batches."
        actions={<Menu label={`Export selected${sel.length ? ` (${sel.length})` : ""}`} icon="download" items={[
          { label: "CSV", icon: "sheet", disabled: !sel.length, onClick: () => exportAs({ format: "csv" }) },
          { label: "Excel (.xlsx)", icon: "sheet", disabled: !sel.length, onClick: () => exportAs({ format: "xlsx" }) },
          { label: "Detailed JSON", icon: "file", disabled: !sel.length, onClick: () => exportAs({ format: "json", detailed: true }) },
        ]} />}
      />
      <Card bodyClass="p-0" title={videos.data ? `${videos.data.total} videos` : "Videos"}
        action={sel.length > 0 && <><Badge kind="neutral">{sel.length} selected</Badge><button className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button></>}>
        <div className="border-b border-border p-3 sm:p-4"><Filters value={filters} onChange={setFilters} batches={batches.data?.items || []} categories={categories} /></div>
        {videos.error ? <ErrorState error={videos.error} onRetry={videos.reload} /> : !videos.data ? <Loading /> : (
          <VideoTable items={videos.data.items} threshold={videos.data.threshold} selected={selected} onSelect={setSelected} showBatch
            onRetry={async (v) => { try { const r = await api.retry(v.id); toast(`Retrying from ${r.stages.join(" + ")}`, "success"); refresh(); } catch (e) { toast(e.message, "error"); } }} />
        )}
      </Card>
    </>
  );
}

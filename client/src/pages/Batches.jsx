import { Link } from "react-router-dom";
import { api } from "../services/api.js";
import { useApi, useEvents, useDebounced } from "../hooks/index.js";
import { PageHeader } from "../components/Layout.jsx";
import { Card, PageSkeleton, ErrorState, Empty, ProgressBar, TableScroll } from "../components/ui.jsx";
import Icon from "../components/Icons.jsx";
import { BatchBadge } from "./Overview.jsx";
import { fmtDate } from "../utils/format.js";

export default function Batches() {
  const { data, error, reload } = useApi(() => api.batches());
  const refresh = useDebounced(() => reload({ silent: true }), 800);
  useEvents((e) => e.type === "batch" && refresh());
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <PageSkeleton />;
  return (
    <>
      <PageHeader title="Batches" subtitle="Each uploaded spreadsheet becomes a batch." actions={<Link to="/upload" className="btn-primary"><Icon name="upload" />New batch</Link>} />
      <Card bodyClass="p-0">
        {!data.items.length ? <Empty icon="sheet" title="No batches yet" action={<Link to="/upload" className="btn-primary btn-sm">Upload a spreadsheet</Link>} /> : (
          <>
            {/* mobile: cards */}
            <ul className="divide-y divide-border md:hidden">
              {data.items.map(b => {
                const done = b.completed_videos + b.failed_videos + b.skipped_videos;
                return (
                  <li key={b.id}>
                    <Link to={`/batches/${b.id}`} className="block px-4 py-4 transition-colors hover:bg-sunken">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="break-words font-bold">{b.filename}</p>
                          <p className="text-xs text-muted">{b.total_videos} videos{b.purpose === "dataset" && " · training dataset"} · {fmtDate(b.created_at)}</p>
                        </div>
                        <BatchBadge status={b.status} />
                      </div>
                      <div className="mt-3"><ProgressBar value={done} max={b.total_videos || 1} /></div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular">
                        <span className="text-muted">{done} of {b.total_videos} finished</span>
                        <span className="text-success">{b.completed_videos} completed</span>
                        <span className="text-muted">{b.skipped_videos} skipped</span>
                        <span className={b.failed_videos ? "text-error" : "text-muted"}>{b.failed_videos} failed</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {/* tablet / desktop: table */}
            <TableScroll label="Batches" className="hidden md:block">
              <table className="table min-w-[720px]">
                <thead><tr><th>File</th><th>Status</th><th className="w-56">Progress</th><th className="text-right">Completed</th><th className="text-right">Skipped</th><th className="text-right">Failed</th><th>Created</th></tr></thead>
                <tbody>
                  {data.items.map(b => {
                    const done = b.completed_videos + b.failed_videos + b.skipped_videos;
                    return (
                      <tr key={b.id}>
                        <td className="max-w-72"><Link to={`/batches/${b.id}`} className="block truncate font-bold hover:underline">{b.filename}</Link><p className="text-xs text-muted">{b.total_videos} videos{b.purpose === "dataset" && " · training dataset"}</p></td>
                        <td><BatchBadge status={b.status} /></td>
                        <td><ProgressBar value={done} max={b.total_videos || 1} /><p className="mt-1 text-xs tabular text-muted">{done} of {b.total_videos} finished</p></td>
                        <td className="text-right tabular text-success">{b.completed_videos}</td>
                        <td className="text-right tabular text-muted">{b.skipped_videos}</td>
                        <td className={`text-right tabular ${b.failed_videos ? "text-error" : "text-muted"}`}>{b.failed_videos}</td>
                        <td className="whitespace-nowrap text-muted">{fmtDate(b.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </>
        )}
      </Card>
    </>
  );
}

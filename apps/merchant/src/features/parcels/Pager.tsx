/** A list's footer: "Showing 1–25 of 120 …", rows per page and numbered pages (shared/table-pager.js). */
import { num } from "@panel/lib/format";
import { Select } from "@panel/ui/Select";

export const PAGE_SIZES = [25, 50, 100];

export function Pager({ page, pages, size, total, shown, noun, busy, setPage, setSize }: { page: number; pages: number; size: number; total: number; shown: number; noun: string; busy?: boolean; setPage: (p: number) => void; setSize: (s: number) => void }) {
  const first = (page - 1) * size + 1;
  const near = [...new Set([1, page - 1, page, page + 1, pages])].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  return (
    <div className="panel-foot">
      <span>{total ? `Showing ${num(first)}–${num(first + shown - 1)} of ${num(total)} ${noun}${total === 1 ? "" : "s"}` : `No matching ${noun}s`}</span>
      <span className="row" style={{ gap: 6 }}>
        <label className="row" style={{ gap: 6 }}>
          Rows per page
          <Select className="select sm" aria-label="Rows per page" value={size} onChange={e => setSize(Number(e.target.value))}>
            {PAGE_SIZES.map(s => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </label>
        {pages > 1 ? (
          <nav className="pager" aria-label="Pages">
            <button type="button" className="button sm" aria-label="Previous page" disabled={page === 1 || busy} onClick={() => setPage(page - 1)}>
              ‹
            </button>
            {near.map((n, i) => (
              <span key={n} style={{ display: "contents" }}>
                {i && n - near[i - 1] > 1 ? <span aria-hidden="true">…</span> : null}
                <button type="button" className={`button sm ${n === page ? "primary" : ""}`} aria-current={n === page ? "page" : undefined} aria-label={`Page ${n}`} onClick={() => setPage(n)}>
                  {num(n)}
                </button>
              </span>
            ))}
            <button type="button" className="button sm" aria-label="Next page" disabled={page === pages || busy} onClick={() => setPage(page + 1)}>
              ›
            </button>
          </nav>
        ) : null}
      </span>
    </div>
  );
}

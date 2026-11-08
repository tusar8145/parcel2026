/** A list's footer: "Showing 1–25 of 120 …", rows per page and numbered pages (shared/table-pager.js). */
import { useState } from "react";
import { num } from "../lib/format";
import { Select } from "./Select";

export const PAGE_SIZES = [25, 50, 100];

export function Pager({ page, pages, size, total, shown, noun, busy, setPage, setSize, sizes = PAGE_SIZES, text }: { page: number; pages: number; size: number; total: number; shown: number; noun: string; busy?: boolean; setPage: (p: number) => void; setSize: (s: number) => void; sizes?: number[]; text?: string }) {
  const first = (page - 1) * size + 1;
  const near = [...new Set([1, page - 1, page, page + 1, pages])].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  return (
    <div className="panel-foot">
      <span>{text ?? (total ? `Showing ${num(first)}–${num(first + shown - 1)} of ${num(total)} ${noun}${total === 1 ? "" : "s"}` : `No matching ${noun}s`)}</span>
      <span className="row" style={{ gap: 6 }}>
        <label className="row" style={{ gap: 6 }}>
          Rows per page
          <Select className="select sm" aria-label="Rows per page" value={size} onChange={e => setSize(Number(e.target.value))}>
            {sizes.map(s => (
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

/** Pages of a list held in memory (the classic shared/table-pager.js): the rows on the current page and the Pager's props. */
export function usePaged<T>(items: T[], initial = 20) {
  const [size, setSizeState] = useState(initial);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages);
  const rows = items.slice((current - 1) * size, current * size);
  return { rows, pager: { page: current, pages, size, total: items.length, shown: rows.length, setPage, setSize: (s: number) => (setSizeState(s), setPage(1)) } };
}

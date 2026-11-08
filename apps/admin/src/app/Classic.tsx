import { Icon } from "@panel/ui/Icon";
import { PageHeading, Panel } from "@panel/ui/kit";
import { pageById } from "./nav";

/** While a page is being rebuilt: it opens in the classic panel (same account, same data). */
export function Classic({ id }: { id: string }) {
  const page = pageById(id);
  return (
    <>
      <PageHeading title={page?.label ?? id} />
      <Panel>
        <div className="panel-body">
          <p style={{ margin: "4px 0 12px" }}>This page is still being rebuilt here. It works in the classic panel, with the same account and data.</p>
          <a className="button primary" href={`/super-admin?classic=1&page=${page?.slug ?? "overview"}`} target="_blank" rel="noopener" onClick={() => (document.cookie = "df-classic-admin=1; path=/; SameSite=Lax")}>
            Open {page?.label ?? id} in the classic panel <Icon name="external" size={12} />
          </a>
        </div>
      </Panel>
    </>
  );
}

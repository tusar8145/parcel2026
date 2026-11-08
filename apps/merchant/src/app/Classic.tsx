import { PageHeading, Panel } from "@panel/ui/kit";
import { Icon } from "@panel/ui/Icon";
import { pageById } from "./nav";

/** While a page is being rebuilt: it opens in the classic panel (same account, same data). */
export function Classic({ id }: { id: string }) {
  const page = pageById(id);
  const slug = id === "Notifications" ? "notifications" : (page?.legacy[0] ?? "overview");
  return (
    <>
      <PageHeading title={page?.label ?? id} />
      <Panel>
        <div className="panel-body">
        <p style={{ margin: "4px 0 12px" }}>This page is still being rebuilt here. It works in the classic panel, with the same account and data.</p>
        <a className="button primary" href={`/banking-merchant?page=${slug}`} target="_blank" rel="noopener">
          Open {page?.label ?? id} in the classic panel <Icon name="external" size={12} />
        </a>
        </div>
      </Panel>
    </>
  );
}

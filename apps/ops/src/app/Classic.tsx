import { PageHeading } from "@panel/ui/kit";
import { ClassicLink } from "@/features/parcels/HeadingTools";
import ViewTabs from "./ViewTabs";
import type { ViewDef } from "./nav";

/** A tab not rebuilt here yet: the same work in the classic console (same data, same session). */
export function Classic({ view, tab, page, title }: { view?: ViewDef; tab?: string; page: string; title?: string }) {
  return (
    <>
      <PageHeading title={title ?? view?.label ?? page} subtitle={view?.subtitle} />
      {view && tab ? <ViewTabs view={view.id} tab={tab} /> : null}
      <div className="panel panel-body stack">
        <div className="callout">
          {tab && view && view.tabs.length > 1 ? `${view.label} › ${tab}` : title ?? view?.label} is being rebuilt in the new console. Until then it works in the classic console, on the same data and with the same sign-in.
        </div>
        <div>
          <ClassicLink page={page} tab={view && view.tabs.length > 1 ? tab : undefined} label={`Open ${tab && view && view.tabs.length > 1 ? tab : title ?? view?.label} in the classic console`} primary />
        </div>
      </div>
    </>
  );
}

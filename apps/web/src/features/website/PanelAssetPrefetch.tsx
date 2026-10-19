"use client";

import { useEffect } from "react";
import { scripts as courierScripts } from "@/features/courier-operation/scripts";
import { scripts as riderScripts } from "@/features/rider/scripts";
import { scripts as superAdminScripts } from "@/features/super-admin/scripts";
import { scripts as franchiseScripts } from "@/features/franchise/scripts";
import { scripts as ecommerceScripts } from "@/features/ecommerce-merchant/scripts";
import { scripts as bankingScripts } from "@/features/banking-merchant/scripts";
import { scripts as applicationScripts } from "@/features/application/scripts";
import { scripts as websiteScripts } from "./scripts";

const ASSET_VERSIONS: Record<string, string> = JSON.parse(process.env.LEGACY_ASSET_VERSIONS || "{}");
const PANELS = [courierScripts, riderScripts, superAdminScripts, franchiseScripts, ecommerceScripts, bankingScripts, applicationScripts];

function versioned(src: string) {
  const version = ASSET_VERSIONS[src];
  return version ? `${src}?v=${version}` : src;
}

export default function PanelAssetPrefetch() {
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!Object.keys(ASSET_VERSIONS).length || !navigator.onLine || connection?.saveData || /^(slow-2g|2g)$/.test(connection?.effectiveType || "")) return;

    const alreadyLoaded = new Set(websiteScripts);
    const assets = [...new Set(PANELS.flat())].filter(src => src.startsWith("/legacy/") && !alreadyLoaded.has(src));
    const prefetch = () => {
      for (const src of assets) {
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.as = "script";
        link.href = versioned(src);
        document.head.appendChild(link);
      }
    };
    const win = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number };
    if (win.requestIdleCallback) win.requestIdleCallback(prefetch, { timeout: 5000 });
    else window.setTimeout(prefetch, 1500);
  }, []);

  return null;
}

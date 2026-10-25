/*
 * Courier Operations sidebar: super admins get a link back to the super admin panel (the super admin sidebar
 * has "Open courier operations console" the other way). Nobody else sees it.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  Promise.resolve(DF.bridgeReady)
    .catch(() => undefined)
    .then(() => {
      if (!DF.auth?.hasRole?.("SUPER_ADMIN") || document.getElementById("dfAdminLink")) return;
      const bottom = document.querySelector(".sidebar .sidebar-bottom") || document.querySelector(".sidebar-bottom");
      if (!bottom) return;
      bottom.insertAdjacentHTML(
        "afterbegin",
        `<a id="dfAdminLink" href="/super-admin" style="display:flex;align-items:center;gap:9px;margin:0 2px 11px;padding:10px;border:1px solid #e9edff;border-radius:8px;background:#f7f8ff;color:#576a9b;text-decoration:none;font-size:12px;font-weight:600"><svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" style="width:15px;height:15px;flex:none" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>Open super admin panel ↗</a>`,
      );
    });
})();

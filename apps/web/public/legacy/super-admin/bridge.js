/*
 * Connects the super admin panel to the API.
 *
 * - Platform settings: every write the page makes to the "deliveryfast-demo-config" key
 *   (notifications, service plans, rider plans, catalogs…) is saved with
 *   PUT /settings/platform-config, so every page sees it. Nothing is kept in this browser.
 * - Server-owned data replaces the samples: merchants and registrations (/merchants), service
 *   plans (/plans), rate cards (/rate-cards), the booking catalog (/catalog), administrators
 *   (/users), riders (/riders), hubs (/hubs), the audit log (/audit-logs), recent parcels
 *   (/parcels) and platform counts (/admin/overview).
 * - Actions with a backend go through it first (approve/reject/suspend merchants, assign plans,
 *   save plans and tariffs as new rate card versions, edit the catalog, invite administrators);
 *   then the page's own handler runs to update its screen, as before.
 * - Rate cards, per-document-type rates and merchant (Enterprise) tariffs need a second super
 *   admin's approval when there is one (maker-checker): the API answers 202 and the change waits
 *   in the queue on Admin users & roles (bridge-security.js), which also owns MFA, roles, support
 *   access and the real traffic chart.
 * Purely illustrative widgets (integrations health, growth trend) are unchanged.
 */
(() => {
  const DF = window.DF;
  const CONFIG_KEY = "deliveryfast-demo-config";
  const plansUI = window.DFServicePlans; // exposed by 03.js
  const STAFF_ROLES = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"];
  const ROLE_LABEL = {
    SUPER_ADMIN: "Super Administrator",
    OPS_MANAGER: "Operations Administrator",
    FINANCE: "Finance Administrator",
    SUPPORT_AGENT: "Merchant Support",
    HUB_OPERATOR: "Hub Manager",
  };
  const ROLE_SCOPE = { SUPER_ADMIN: "Platform-wide", OPS_MANAGER: "Courier operations", FINANCE: "COD & billing", SUPPORT_AGENT: "Merchant accounts" };
  const INVITE_ROLE = {
    "Operations Administrator": "OPS_MANAGER",
    "Finance Administrator": "FINANCE",
    "Merchant Support": "SUPPORT_AGENT",
    "Hub Manager": "HUB_OPERATOR",
  };
  const SEGMENT = { ecommerce: "ECOMMERCE", document: "BANKING_FINANCIAL" };
  const KIND = { ECOMMERCE: "ecommerce", BANKING_FINANCIAL: "document" };
  const LEVELS = [
    ["REGULAR", "Regular"],
    ["SAME_DAY", "Same day"],
    ["EXPRESS", "Express"],
  ];
  const LIVE_PAGES = new Set([
    "Overview",
    "Registrations",
    "Approvals",
    "Merchants",
    "E-commerce merchants",
    "Banking & Financial merchants",
    "Platform activity",
    "Audit log",
    "Admin users",
  ]);
  const RETIRED = new Set([
    "Plans & billing",
    "Customer parcels",
    "Customer parcel pricing",
    "E-commerce settings",
    "Document settings",
    "E-commerce pricing",
    "Document pricing",
  ]);

  const S = { merchants: [], plans: [], cards: null, catalog: null, overview: null, staff: [], riders: [], hubs: [], audit: [], parcels: [] };
  /** Registration decisions made in this session, so the queue shows them like the original did. */
  const decided = new Map();
  let currentPage = "Overview";

  DF.showSignedInUser("Super admin");

  // ───────────── formatting ─────────────
  const DHAKA = "Asia/Dhaka";
  const dayKey = d => d.toLocaleDateString("en-CA", { timeZone: DHAKA });
  const time = d => d.toLocaleTimeString("en-US", { timeZone: DHAKA, hour: "numeric", minute: "2-digit" });
  function when(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const today = dayKey(new Date());
    const yesterday = dayKey(new Date(Date.now() - 864e5));
    if (dayKey(d) === today) return `Today, ${time(d)}`;
    if (dayKey(d) === yesterday) return `Yesterday, ${time(d)}`;
    return `${d.toLocaleDateString("en-US", { timeZone: DHAKA, month: "short", day: "numeric" })}, ${time(d)}`;
  }
  const date = iso => new Date(iso).toLocaleDateString("en-US", { timeZone: DHAKA, month: "short", day: "numeric", year: "numeric" });
  const num = n => Number(n || 0).toLocaleString("en-US");
  function taka(n) {
    n = Number(n || 0);
    if (n >= 1e6) return `৳ ${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e4) return `৳ ${(n / 1e3).toFixed(1)}K`;
    return `৳ ${num(n)}`;
  }
  const phone = p => DF.localPhone(p || "").replace(/^(\d{5})(\d{6})$/, "$1-$2");
  const round2 = n => Math.round(Number(n) * 100) / 100;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const replaceAll = (list, items) => list.splice(0, list.length, ...items);
  const replaceKeys = (object, entries) => {
    for (const key of Object.keys(object)) delete object[key];
    Object.assign(object, entries);
  };

  // ───────────── platform settings (PUT /settings/platform-config) ─────────────
  const config = (() => {
    let pending = null;
    let timer = null;
    let chain = Promise.resolve();
    function flush() {
      timer = null;
      chain = chain.then(async () => {
        const body = pending;
        pending = null;
        if (!body) return;
        try {
          const saved = await DF.api("/settings/platform-config", { method: "PUT", body });
          if (!pending) DF.state.platformConfig = saved;
        } catch (error) {
          showToast(`Settings were not saved: ${DF.describe(error)}`);
        }
      });
    }
    return {
      current: () => {
        try {
          return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") || {};
        } catch {
          return {};
        }
      },
      /** Takes the whole config; several writes in one handler are sent as one request. */
      save(next) {
        DF.state.platformConfig = next;
        pending = next;
        timer ??= setTimeout(flush, 0);
      },
    };
  })();

  // The page scripts write the shared config to localStorage; send it to the server instead.
  const pageSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    let local = false;
    try {
      local = this === window.localStorage;
    } catch {}
    if (local && key === CONFIG_KEY) {
      try {
        config.save(JSON.parse(value));
      } catch (error) {
        console.error("Platform settings could not be read", error);
      }
      return;
    }
    return pageSetItem.call(this, key, value);
  };

  // ───────────── loading ─────────────
  async function all(path) {
    const items = [];
    let cursor = null;
    do {
      const page = await DF.api(`${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && items.length < 2000);
    return items;
  }

  const loaders = {
    // With the service package each merchant books with (super admin → Service plans & pricing assigns them).
    merchants: async () => {
      const [list, ...segments] = await Promise.all([
        all("/merchants"),
        ...["ECOMMERCE", "BANKING_FINANCIAL"].map(segment => DF.api(`/packages/assignments?segment=${segment}`).catch(() => [])),
      ]);
      const packages = new Map(segments.flat().map(a => [a.merchant.id, a.package]));
      S.merchants = list.map(m => ({ ...m, package: packages.get(m.id) ?? null }));
    },
    plans: async () => (S.plans = await DF.api("/plans?includeInactive=true")),
    cards: async () => (S.cards = await DF.api("/rate-cards/current")),
    catalog: async () => (S.catalog = await DF.api("/catalog")),
    overview: async () => (S.overview = await DF.api("/admin/overview")),
    staff: async () => (S.staff = await all(`/users?roles=${STAFF_ROLES.join(",")}`)),
    riders: async () => (S.riders = await DF.api("/riders")),
    hubs: async () => (S.hubs = await DF.api("/hubs?includeInactive=true")),
    audit: async () => (S.audit = (await DF.api("/audit-logs?limit=100")).items),
    parcels: async () => DF.parcels.set((S.parcels = (await DF.api("/parcels?limit=50")).items)),
  };
  /** Loads the given data sets, then rebuilds the page's arrays. Returns whether anything changed. */
  async function load(...names) {
    const before = JSON.stringify(names.map(n => S[n]));
    const results = await Promise.allSettled(names.map(n => loaders[n]()));
    apply();
    const failed = results.find(r => r.status === "rejected");
    if (failed) throw failed.reason;
    return before !== JSON.stringify(names.map(n => S[n]));
  }

  // ───────────── server data → the page's arrays ─────────────
  const merchantCode = m => m.code;
  const kindOf = m => KIND[m.type];
  const activity = id => S.overview?.merchantActivity.find(a => a.merchantId === id);
  const plansFor = segment => S.plans.filter(p => p.segment === segment);
  const planNamed = (segment, name) => plansFor(segment).find(p => p.name.toLowerCase() === String(name).toLowerCase());

  /** The merchant's service package ("E-commerce default (default)"); service packages replaced service plans. */
  const packageLabel = m => (m.package ? `${m.package.name}${m.package.isDefault ? " (default)" : ""}` : "Default package");

  function legacyMerchant(m) {
    const docs = m.type === "BANKING_FINANCIAL";
    return {
      id: merchantCode(m),
      name: m.name,
      owner: m.contactName,
      email: m.contactEmail || phone(m.contactPhone),
      plan: packageLabel(m),
      type: docs ? "Banking & Financial merchant" : "E-commerce merchant",
      services: docs ? "Secure documents · OTP" : "E-commerce · COD",
      joined: date(m.createdAt),
      shipments: num(activity(m.id)?.parcelsThisMonth),
      discount: m.plan?.discountPct || 0,
      status: { ACTIVE: "Active", SUSPENDED: "Suspended", PENDING_REVIEW: "Under review", INFO_REQUESTED: "Under review", REJECTED: "Rejected" }[m.status],
      _api: m,
    };
  }

  function legacyRegistration(m, status = "Pending review") {
    return {
      id: merchantCode(m),
      business: m.name,
      owner: m.contactName,
      email: m.contactEmail || "—",
      phone: phone(m.contactPhone),
      type: m.type === "BANKING_FINANCIAL" ? "Banking & Financial merchant" : "E-commerce",
      city: m.pickup?.zone ? `${m.pickup.zone}, ${m.pickupDistrict}` : m.pickupDistrict,
      plan: packageLabel(m),
      submitted: when(m.createdAt),
      status,
      _api: m,
    };
  }

  const AUDIT_TITLE = {
    "auth.login": "Signed in",
    "auth.signup": "Account created",
    "auth.locked": "Account locked after failed sign-ins",
    "auth.password_changed": "Password changed",
    "auth.password_reset": "Password reset",
    "merchant.apply": "Merchant application submitted",
    "merchant.approve": "Merchant account approved",
    "merchant.suspend": "Merchant account suspended",
    "merchant.update": "Merchant account updated",
    "merchant.self_update": "Merchant profile updated",
    "plan.create": "Service plan created",
    "plan.update": "Service plan updated",
    "rate_card.create": "Rate card published",
    "rate_card.deactivate": "Rate card withdrawn",
    "catalog.update": "Booking catalog updated",
    "platform_config.update": "Platform settings updated",
    "user.create": "Administrator account created",
    "user.status_change": "Account status changed",
    "user.role_add": "Role granted",
    "user.role_remove": "Role removed",
    "auth.mfa_enabled": "Two-step verification turned on",
    "auth.mfa_disabled": "Two-step verification turned off",
    "auth.mfa_reset": "Two-step verification reset",
    "auth.mfa_challenge": "Two-step verification requested",
    "auth.mfa_setup_required": "Two-step verification setup requested",
    "auth.mfa_failed": "Wrong two-step code",
    "auth.mfa_locked": "Two-step verification locked after wrong codes",
    "auth.mfa_recovery_code_used": "Recovery code used",
    "change.request": "Change sent for approval",
    "change.approve": "Change approved",
    "change.reject": "Change rejected",
    "change.cancel": "Change withdrawn",
    "change.applied": "Change applied",
    "change.failed": "Approved change could not be applied",
    "role.permissions_update": "Role permissions changed",
    "custom_role.create": "Custom role created",
    "custom_role.update": "Custom role changed",
    "custom_role.delete": "Custom role deleted",
    "merchant_rate.set": "Merchant tariff set",
    "merchant_rate.remove": "Merchant tariff removed",
    "impersonation.start": "Support access started",
    "impersonation.end": "Support access ended",
    "impersonation.request": "Request during support access",
    "parcel.create": "Parcel booked",
    "parcel.status_change": "Parcel status changed",
    "settlement.approve": "Settlement approved",
    "settlement.pay": "Settlement paid",
    "api_key.create": "API key created",
    "api_key.revoke": "API key revoked",
  };
  const auditTitle = a => AUDIT_TITLE[a.action] || a.action.replace(/[._]/g, " ").replace(/^./, c => c.toUpperCase());
  const SETTING_LABEL = { "platform-config": "Platform settings", catalog: "Booking catalog" };
  function auditScope(a) {
    if (a.action.startsWith("auth.")) return "Platform access";
    if (a.data?.trackingId) return a.data.trackingId;
    const merchant = a.entityType === "merchant" && S.merchants.find(m => m.id === a.entityId);
    if (merchant) return `${merchant.name} · ${merchant.code}`;
    const user = a.entityType === "user" && S.staff.find(u => u.id === a.entityId);
    if (user) return user.name;
    const plan = a.entityType === "service_plan" && S.plans.find(p => p.id === a.entityId);
    if (plan) return `${plan.name} plan · ${plan.segment === "BANKING_FINANCIAL" ? "documents" : plan.segment.toLowerCase()}`;
    if (a.entityType === "setting") return SETTING_LABEL[a.entityId] || a.entityId;
    if (a.data?.name) return a.data.name;
    if (a.data?.code) return a.data.code;
    return a.entityType && a.entityId ? `${a.entityType.replace(/_/g, " ")} ${a.entityId.length > 20 ? a.entityId.slice(-6) : a.entityId}` : "Platform";
  }
  const auditSource = a => (a.actorType === "API_KEY" ? "Merchant API" : a.actorType === "SYSTEM" ? "Automation" : a.ip ? `Web · ${a.ip}` : "Web");
  function auditKind(a) {
    if (
      a.actorType === "API_KEY" ||
      a.entityType === "merchant" ||
      a.action.startsWith("merchant.") ||
      a.action.startsWith("api_key.") ||
      a.action.startsWith("webhook.")
    )
      return "merchant";
    if (a.entityType === "rider" || a.action.startsWith("cod.")) return "rider";
    if (a.action === "parcel.status_change") return "tracking";
    if (a.action.startsWith("parcel.") || a.action.startsWith("auth.") || a.action.startsWith("address.") || a.action.startsWith("profile.")) return "website";
    return "admin";
  }
  const KIND_ICON = { merchant: "building", rider: "truck", tracking: "search", website: "users", admin: "settings" };
  const AUDIT_ICON = { merchant: "check", rider: "truck", tracking: "search", website: "users", admin: "settings" };

  function apply() {
    // Open applications (incl. information requested) are registrations; rejected ones stay listed there (bridge-merchants.js).
    const open = ["PENDING_REVIEW", "INFO_REQUESTED"];
    const pending = S.merchants.filter(m => open.includes(m.status));
    const accounts = S.merchants.filter(m => !open.includes(m.status) && m.status !== "REJECTED");
    replaceAll(merchants, accounts.map(legacyMerchant));
    replaceAll(registrations, [
      ...pending.map(m => legacyRegistration(m, m.status === "INFO_REQUESTED" ? "More information requested" : "Pending review")),
      ...S.merchants.filter(m => m.status === "REJECTED").map(m => legacyRegistration(m, "Rejected")),
      ...[...decided]
        .filter(([id]) => S.merchants.find(m => m.id === id)?.status !== "REJECTED")
        .map(
          ([id, status]) =>
            S.merchants.find(m => m.id === id) &&
            legacyRegistration(
              S.merchants.find(m => m.id === id),
              status,
            ),
        )
        .filter(Boolean),
    ]);

    // Per-merchant settings kept in the platform config, keyed by merchant code.
    const saved = config.current();
    replaceAll(
      serviceEntitlements,
      merchants.map(m => {
        const docs = m.type === "Banking & Financial merchant";
        const base = { id: m.id, name: m.name, ecommerce: !docs, document: docs, domestic: docs, cod: !docs };
        const stored = Array.isArray(saved.entitlements) ? saved.entitlements.find(e => e.id === m.id) : null;
        for (const key of ["ecommerce", "domestic", "document", "cod"]) if (typeof stored?.[key] === "boolean") base[key] = stored[key];
        return base;
      }),
    );
    replaceKeys(merchantDiscounts, Object.fromEntries(merchants.map(m => [m.id, Number(saved.merchantDiscounts?.[m.id]) || 0])));
    replaceKeys(
      activityMerchantDetails,
      Object.fromEntries(
        merchants.map(m => {
          const a = activity(m._api.id);
          return [m.id, [a?.lastParcelAt ? when(a.lastParcelAt) : "No parcels yet", `${num(a?.parcelsThisMonth)} shipments this month`, m.owner]];
        }),
      ),
    );

    // Administrators.
    replaceAll(
      adminUsers,
      S.staff.map(u => {
        const roles = u.roles.filter(r => STAFF_ROLES.includes(r.role)).sort((a, b) => STAFF_ROLES.indexOf(a.role) - STAFF_ROLES.indexOf(b.role));
        const scope = roles.map(r => (r.role === "HUB_OPERATOR" ? r.hub?.name || "Hub" : ROLE_SCOPE[r.role]));
        const status = u.status === "ACTIVE" ? (u.lastLoginAt ? "Active" : "Invited") : u.status === "SUSPENDED" ? "Suspended" : "Disabled";
        return [
          u.name,
          u.email || phone(u.phone),
          roles.map(r => ROLE_LABEL[r.role]).join(" · "),
          [...new Set(scope)].join(" · "),
          status,
          u.lastLoginAt ? when(u.lastLoginAt) : "Not signed in yet",
        ];
      }),
    );

    // Audit log, overview feed and activity events.
    generic["Audit log"].rows = S.audit.map(a => [auditTitle(a), a.actorLabel || "System", auditScope(a), when(a.createdAt), auditSource(a), "Success"]);
    replaceAll(
      auditEntries,
      S.audit.slice(0, 4).map(a => [AUDIT_ICON[auditKind(a)], auditTitle(a), auditScope(a), `${when(a.createdAt)} · ${a.actorLabel || "System"}`]),
    );
    replaceAll(
      platformActivityEvents,
      S.audit.slice(0, 12).map(a => {
        const kind = auditKind(a);
        return {
          kind,
          ico: KIND_ICON[kind],
          actor: a.actorLabel || "System",
          action: `${auditTitle(a).replace(/^./, c => c.toLowerCase())} · ${auditScope(a)}`,
          time: when(a.createdAt),
          source: auditSource(a),
        };
      }),
    );

    // Riders.
    const today = id => S.overview?.riderActivity.find(r => r.riderId === id);
    const SHIFT = { ONLINE: "Online", ON_BREAK: "On break", OFFLINE: "Offline" };
    replaceAll(
      activityRiders,
      S.riders
        .filter(r => r.active)
        .map(r => {
          const t = today(r.id);
          return [
            r.code,
            r.name,
            SHIFT[r.status] || r.status,
            [r.hub?.name, r.zone].filter(Boolean).join(" · ") || "No hub",
            `${num(r.openTasks)} open tasks`,
            `${num(t?.deliveredToday)} deliveries · ${num(t?.pickedUpToday)} pickups`,
          ];
        }),
    );
    if (plansUI) plansUI.riderRows = S.riders.filter(r => r.active).map(r => [r.code, r.name, r.hub?.name || r.zone || "No hub"]);
    replaceAll(activityTrackingSamples, []); // tracking history comes from the parcels below

    applyCatalog();
    applyPricing();
    applyPlans();
    updateApprovalCount();
  }

  function applyCatalog() {
    const c = S.catalog;
    if (!c) return;
    const zones = [...new Set(c.districts.flatMap(d => c.zonesByDistrict[d] || []))];
    replaceAll(geoCatalog.district, c.districts);
    replaceAll(geoCatalog.zone, zones);
    replaceAll(geoCatalog.area, [...new Set(zones.flatMap(z => c.areasByZone[z] || []))]);
    geoHierarchy.zonesByDistrict = structuredClone(c.zonesByDistrict);
    geoHierarchy.areasByZone = structuredClone(c.areasByZone);
    replaceAll(
      deliveryServices,
      LEVELS.map(([, label]) => label),
    );
  }

  const feesByLabel = card => Object.fromEntries(LEVELS.map(([level, label]) => [label, card.serviceFees[level]]));

  function applyPricing() {
    if (!S.cards) return;
    const customer = S.cards.CUSTOMER.config;
    const ecommerce = S.cards.ECOMMERCE.config;
    const documents = S.cards.BANKING_FINANCIAL.config;
    const publicRates = {
      sameZone: customer.sameZone,
      crossZone: customer.crossZone,
      extraWeight: customer.extraWeight,
      codFeePercent: customer.codFeePercent,
      serviceFees: feesByLabel(customer),
    };
    Object.assign(customerParcelPricing, structuredClone(publicRates)); // 02.js
    if (plansUI) Object.assign(plansUI.customerParcelPricing, structuredClone(publicRates)); // 03.js
    Object.assign(merchantPricing.ecommerce, {
      sameZone: ecommerce.sameZone,
      crossZone: ecommerce.crossZone,
      extraWeight: ecommerce.extraWeight,
      returnPercent: ecommerce.returnPercent,
      serviceFees: feesByLabel(ecommerce),
    });
    Object.assign(merchantPricing.document, { sameZone: documents.sameZone, crossZone: documents.crossZone, returnPercent: documents.returnPercent });
    Object.assign(deliveryRates, {
      sameZone: ecommerce.sameZone,
      crossZone: ecommerce.crossZone,
      extraWeight: ecommerce.extraWeight,
      returnPercent: ecommerce.returnPercent,
    });
    Object.assign(serviceLevelFees, feesByLabel(ecommerce));
  }

  /** Server plans and tariffs into the plan editor (03.js). Per-type document rates and product lists stay in the platform config. */
  function applyPlans() {
    if (!plansUI || !S.cards) return;
    const { servicePlans, planNames, serviceLabels, merchantPlanAssignments } = plansUI;
    const labelToKey = Object.fromEntries(Object.entries(serviceLabels).map(([key, label]) => [label, key]));
    for (const plan of S.plans) if (plan.active && KIND[plan.segment] && !planNames.includes(plan.name)) planNames.push(plan.name);
    for (const kind of ["ecommerce", "document"]) {
      const card = S.cards[SEGMENT[kind]].config;
      for (const tier of planNames) {
        const entry = (servicePlans[kind][tier] ||= structuredClone(servicePlans[kind].Starter));
        const server = planNamed(SEGMENT[kind], tier);
        entry._id = server?.id;
        entry.discountPct = server ? server.discountPct : 0;
        if (server) {
          entry.monthlyFee = tier === "Enterprise" && server.monthlyFee === 0 && entry.monthlyFee == null ? null : server.monthlyFee;
          if (server.features.length)
            entry.services = Object.fromEntries(Object.keys(serviceLabels).map(key => [key, server.features.some(f => labelToKey[f] === key)]));
        }
        const p = (entry.pricing ||= {});
        Object.assign(p, { sameZone: card.sameZone, crossZone: card.crossZone, returnPercent: card.returnPercent });
        if (kind === "document" && Object.keys(card.documentTypeRates || {}).length) p.documentRates = { ...(p.documentRates || {}), ...card.documentTypeRates };
        if (kind === "ecommerce")
          Object.assign(p, {
            extraWeight: card.extraWeight,
            codFeePercent: card.codFeePercent,
            regularFee: card.serviceFees.REGULAR,
            sameDayFee: card.serviceFees.SAME_DAY,
            expressFee: card.serviceFees.EXPRESS,
          });
      }
    }
    replaceKeys(
      merchantPlanAssignments,
      Object.fromEntries(S.merchants.filter(m => m.plan && KIND[m.type]).map(m => [merchantCode(m), { type: kindOf(m), plan: m.plan.name }])),
    );
  }

  // ───────────── page decorations (live figures in the original markup) ─────────────
  function setMetric(index, value, trend, note) {
    const metric = document.querySelectorAll("#mainContent .metrics .metric")[index];
    if (!metric) return;
    metric.querySelector(".metric-value").textContent = value;
    const foot = metric.querySelectorAll(".metric-foot span");
    if (trend !== undefined && foot[0]) foot[0].textContent = trend;
    if (note !== undefined && foot[1]) foot[1].textContent = note;
  }
  const setText = (selector, text, index = 0) => {
    const node = document.querySelectorAll(`#mainContent ${selector}`)[index];
    if (node) node.textContent = text;
  };

  function decorate(page) {
    const o = S.overview;
    if (page === "Overview" && o) {
      setMetric(0, num(o.merchants.active + o.merchants.suspended), `${num(o.merchants.newThisMonth)} new`, "this month");
      const groups = Object.values(o.staff.byRole).filter(Boolean).length;
      setMetric(2, num(o.staff.active), `${groups} role group${groups === 1 ? "" : "s"}`, "staff accounts");
      setMetric(3, taka(o.parcels.codThisMonth + o.parcels.chargesThisMonth), `${num(o.parcels.thisMonth)} parcels`, "COD + charges this month");
    }
    if ((page === "Registrations" || page === "Approvals") && o) {
      setMetric(1, num(o.merchants.approvedThisMonth), "approved", "this month");
      setText(".table-footer > span", `Showing ${registrations.length} application records`);
    }
    // "Pricing & catalogs" → Delivery address hierarchy: the geography admin (bridge-geo.js).
    if (page === "Merchants") setText(".metrics .metric:first-child .metric-foot span:last-child", "merchant accounts");
    // The merchant tables' plan column shows the service package.
    if (["Overview", "Merchants", "E-commerce merchants", "Banking & Financial merchants"].includes(page)) {
      document.querySelectorAll("#mainContent table th").forEach(th => th.textContent === "PLAN" && (th.textContent = "PACKAGE"));
      document.querySelectorAll("#mainContent .panel-subtitle").forEach(p => p.textContent === "Account status and service plan oversight" && (p.textContent = "Account status and service packages"));
    }
    if (page === "E-commerce merchants" || page === "Banking & Financial merchants") {
      const docs = page === "Banking & Financial merchants";
      setText(
        ".table-footer > span",
        `Showing ${merchants.filter(m => merchantKind(m) === (docs ? "document" : "ecommerce")).length} ${docs ? "Banking & Financial" : "e-commerce"} accounts`,
      );
    }
    if (page === "Platform activity" && o) {
      const today = new Date(o.periodStarts.today);
      const activeToday = o.merchantActivity.filter(a => a.lastParcelAt && new Date(a.lastParcelAt) >= today).length;
      setMetric(2, num(o.merchants.active), `${num(activeToday)} active today`, "merchant workspaces");
      setMetric(3, num(o.riders.online + o.riders.onBreak), `${num(o.riders.online)} currently online`, "rider activity");
      const tag = document.querySelector("#mainContent .page-heading .activity-tag");
      if (tag) tag.lastChild.textContent = `Live counts · updated ${time(new Date(o.generatedAt))}`;
      const tags = document.querySelectorAll("#mainContent section .panel-heading .activity-tag");
      if (tags[1]) tags[1].textContent = `${merchants.length} merchant accounts`;
      if (tags[3]) tags[3].textContent = `${num(o.riders.active)} riders active`;
      setText("#platformActivityEvents + .table-footer span", `Showing ${platformActivityEvents.length} recent events`);
      setText("p.table-footer", "Merchant, rider, tracking and user activity are live.");
    }
    if (page === "Audit log" && o) {
      setMetric(0, num(o.auditEventsThisMonth), "this month", "recorded user actions");
      setText(".panel-subtitle", "Platform administration · most recent events");
      setText(".table-footer > span", `Showing ${generic["Audit log"].rows.length} most recent events`);
    }
    if (page === "Admin users") {
      const count = role => S.staff.filter(u => u.status === "ACTIVE" && u.roles.some(r => r.role === role)).length;
      const pills = document.querySelectorAll("#mainContent .setting-card .status");
      ["SUPER_ADMIN", "OPS_MANAGER", "FINANCE", "SUPPORT_AGENT"].forEach((role, i) => {
        if (pills[i]) pills[i].textContent = `${role === "SUPER_ADMIN" ? "Privileged" : "Scoped"} role · ${count(role)} user${count(role) === 1 ? "" : "s"}`;
      });
    }
    if (page === "Service plans") decoratePlanEditor();
  }

  function decoratePlanEditor() {
    const form = document.getElementById("servicePlanEditor");
    if (!form || !S.cards) return;
    const { type, tier, merchantId } = plansUI.editor;
    const segment = SEGMENT[type];
    const heading = [...form.querySelectorAll("h3")].find(h => h.textContent === "Pricing rules");
    const card = S.cards[segment];
    const note = document.createElement("p");
    note.className = "panel-subtitle";
    note.textContent = merchantId
      ? "Saving makes these prices this merchant's own tariff (after a second super admin approves, when there is one). Its quotes and bookings use them, less the plan discount; services and catalog stay in the platform settings."
      : `Route, weight, COD and speed charges${type === "document" ? " and the per-document-type rates" : ""} are the ${type === "document" ? "document" : "e-commerce"} rate card${card.name ? ` (${card.name})` : ""}, shared by every plan of this service line. The plan discount comes off each delivery charge. Price changes need a second super admin's approval.`;
    heading?.after(note);
    if (!merchantId) {
      const server = planNamed(segment, tier);
      const grid = form.querySelector(".plan-price-fields");
      const label = document.createElement("label");
      label.innerHTML = `Plan discount (% of delivery charge)<input type="number" min="0" max="100" step="0.01" name="planDiscount" value="${server ? server.discountPct : 0}" required>`;
      grid?.prepend(label);
    }
    const publicForm = document.getElementById("publicCustomerParcelForm");
    if (publicForm && !publicForm.querySelector("[data-df-note]")) {
      const hint = document.createElement("p");
      hint.className = "panel-subtitle";
      hint.dataset.dfNote = "";
      hint.textContent = `Saving publishes a new customer rate card version${S.cards.CUSTOMER.name ? ` (now: ${S.cards.CUSTOMER.name})` : ""}; the website quotes and bookings use it right away.`;
      publicForm.querySelector(".modal-actions")?.before(hint);
    }
  }

  // The catalog page would print every zone and area of the country as chips: render it without
  // them; bridge-geo.js draws the geography admin (one district / zone at a time, or a search).
  if (typeof window.pricingConfigPage === "function") {
    const basePricingConfigPage = window.pricingConfigPage;
    window.pricingConfigPage = function (...args) {
      if (!S.catalog) return basePricingConfigPage.apply(this, args);
      const zones = geoCatalog.zone.splice(0);
      const areas = geoCatalog.area.splice(0);
      try {
        return basePricingConfigPage.apply(this, args);
      } finally {
        for (const z of zones) geoCatalog.zone.push(z);
        for (const a of areas) geoCatalog.area.push(a);
      }
    };
  }

  // Track the page and add live figures after every render.
  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) {
    baseShowPage(page);
    if (RETIRED.has(page)) return;
    currentPage = page;
    decorate(page);
    // Admin users: re-read the staff list on opening (sign-ins and status changes happen elsewhere).
    if (page === "Admin users" && Date.now() - (showPage.staffAt || 0) > 3000) {
      showPage.staffAt = Date.now();
      void load("staff")
        .then(changed => changed && currentPage === "Admin users" && !document.getElementById("modalBackdrop")?.classList.contains("open") && showPage("Admin users"))
        .catch(() => undefined);
    }
  };

  // ───────────── actions ─────────────
  const passThrough = new WeakSet();
  /** Lets the page's own handler run for an event we already handled through the API. */
  function replay(target, type) {
    passThrough.add(target);
    try {
      target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    } finally {
      passThrough.delete(target);
    }
  }
  const stop = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  async function busy(button, work) {
    if (button) button.disabled = true;
    try {
      return await work();
    } finally {
      if (button) button.disabled = false;
    }
  }
  const fail = error => showToast(DF.describe(error));
  const byCode = code => S.merchants.find(m => m.code === code);
  const nowLabel = () =>
    new Date().toLocaleString("en-GB", { timeZone: DHAKA, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  /**
   * Publishes a new rate card version for the segment if any value changed. Returns false (no
   * change), "applied", or "pending" (waiting for another super admin's approval).
   */
  async function publishCard(segment, changes, label) {
    const current = S.cards[segment].config;
    const next = {
      ...structuredClone(current),
      ...changes,
      serviceFees: { ...current.serviceFees, ...(changes.serviceFees || {}) },
      documentTypeRates: { ...(current.documentTypeRates || {}), ...(changes.documentTypeRates || {}) },
    };
    if (same(next, current)) return false;
    const result = await DF.api("/rate-cards", { method: "POST", body: { segment, name: `${label} · ${nowLabel()}`, config: next } });
    return result?.status === "PENDING" ? "pending" : "applied";
  }
  const PENDING_TEXT = "Price change sent for approval: another super admin has to approve it (Admin users & roles). Prices stay as they are until then.";
  /** A change waits for approval: show the current (unchanged) data instead of the page's optimistic update. */
  function showPending(text = PENDING_TEXT) {
    if (document.getElementById("modalBackdrop")?.classList.contains("open")) closeModal();
    showPage(currentPage);
    showToast(text);
  }

  /** The server plan for a tier, created from the editor's settings the first time it's used. */
  async function ensurePlan(kind, tier) {
    const segment = SEGMENT[kind];
    const existing = planNamed(segment, tier);
    if (existing) return existing;
    const entry = plansUI.servicePlans[kind][tier] || {};
    const created = await DF.api("/plans", {
      method: "POST",
      body: { segment, name: tier, monthlyFee: round2(entry.monthlyFee || 0), discountPct: 0, features: features(entry.services) },
    });
    S.plans.push(created);
    return created;
  }
  const features = services =>
    Object.entries(services || {})
      .filter(([, on]) => on)
      .map(([key]) => plansUI.serviceLabels[key])
      .filter(Boolean)
      .slice(0, 30);

  window.addEventListener(
    "submit",
    event => {
      const form = event.target;
      if (passThrough.has(form)) return;

      // Public customer parcel rates → a new CUSTOMER rate card.
      if (form.id === "publicCustomerParcelForm" || form.id === "customerParcelPricingForm") {
        stop(event);
        const data = new FormData(form);
        const fee = label => Number(data.get(`serviceFee:${label}`) || 0);
        const changes = {
          sameZone: Number(data.get("sameZone")),
          crossZone: Number(data.get("crossZone")),
          extraWeight: Number(data.get("extraWeight")),
          codFeePercent: Number(data.get("codFeePercent")),
          serviceFees: Object.fromEntries(LEVELS.map(([level, label]) => [level, fee(label)])),
        };
        void busy(form.querySelector('[type="submit"]'), async () => {
          try {
            const outcome = await publishCard("CUSTOMER", changes, "Customer parcels");
            await load("cards", "audit");
            if (outcome === "pending") return showPending();
            replay(form, "submit");
          } catch (error) {
            fail(error);
          }
        });
        return;
      }

      // Plan editor → /plans (fee, discount, services) and the segment's rate card.
      if (form.id === "servicePlanEditor") {
        const { type, tier, merchantId } = plansUI.editor;
        const data = new FormData(form);
        const documentRates = Object.fromEntries(
          [...data.keys()].filter(key => key.startsWith("price:document:")).map(key => [key.slice("price:document:".length), Number(data.get(key))]),
        );
        // A merchant's custom Enterprise configuration → its own tariff (PUT /merchants/:id/tariff), priced in bookings.
        if (merchantId) {
          const m = byCode(merchantId);
          if (!m) return; // the page keeps it in the platform settings
          stop(event);
          const price = key => Number(data.get(`price:${key}`));
          const config = { sameZone: price("sameZone"), crossZone: price("crossZone"), returnPercent: price("returnPercent") };
          if (type === "document") config.documentTypeRates = documentRates;
          else
            Object.assign(config, {
              extraWeight: price("extraWeight"),
              codFeePercent: price("codFeePercent"),
              serviceFees: { REGULAR: price("regularFee"), SAME_DAY: price("sameDayFee"), EXPRESS: price("expressFee") },
            });
          void busy(form.querySelector('[type="submit"]'), async () => {
            try {
              const result = await DF.api(`/merchants/${m.id}/tariff`, { method: "PUT", body: { config, note: `${tier} configuration` } });
              await load("audit");
              if (result?.status === "PENDING") return showPending(`${m.name}: custom tariff sent for approval to another super admin. Bookings keep the current prices until then.`);
              replay(form, "submit");
            } catch (error) {
              fail(error);
            }
          });
          return;
        }
        if (data.has("documentProducts")) {
          const types = String(data.get("documentTypes") || "")
            .split(",")
            .map(v => v.trim())
            .filter(Boolean);
          const unknown = String(data.get("documentProducts"))
            .split(/\r?\n/)
            .map(line => line.split("="))
            .filter(parts => parts.length >= 2 && parts[0].trim())
            .some(parts => !types.includes(parts.slice(1).join("=").trim()));
          if (unknown) return; // the page explains the problem
        }
        stop(event);
        const segment = SEGMENT[type];
        const price = key => Number(data.get(`price:${key}`));
        const changes = { sameZone: price("sameZone"), crossZone: price("crossZone"), returnPercent: price("returnPercent") };
        if (type === "document" && Object.keys(documentRates).length) changes.documentTypeRates = documentRates;
        if (type === "ecommerce")
          Object.assign(changes, {
            extraWeight: price("extraWeight"),
            codFeePercent: price("codFeePercent"),
            serviceFees: { REGULAR: price("regularFee"), SAME_DAY: price("sameDayFee"), EXPRESS: price("expressFee") },
          });
        const services = Object.fromEntries(Object.keys(plansUI.serviceLabels).map(key => [key, !!form.elements[`service:${key}`]?.checked]));
        const body = {
          monthlyFee: round2(data.get("monthlyFee") === "" ? 0 : Number(data.get("monthlyFee"))),
          discountPct: round2(data.get("planDiscount") ?? 0),
          features: features(services),
        };
        void busy(form.querySelector('[type="submit"]'), async () => {
          try {
            const existing = planNamed(segment, tier);
            if (existing) await DF.api(`/plans/${existing.id}`, { method: "PATCH", body: existing.active ? body : { ...body, active: true } });
            else await DF.api("/plans", { method: "POST", body: { segment, name: tier, ...body } });
            const outcome = await publishCard(segment, changes, type === "document" ? "Banking & Financial" : "E-commerce");
            await load("plans", "cards", "merchants", "audit");
            if (outcome === "pending") return showPending("Plan saved. Its price changes were sent for approval to another super admin; current prices apply until then.");
            replay(form, "submit");
          } catch (error) {
            fail(error);
          }
        });
        return;
      }

      // Catalog lists that bookings use → PUT /catalog (the platform settings mirror it).
      if (form.matches?.(".catalog-form")) {
        const list = form.dataset.catalogForm;
        const value = String(new FormData(form).get("item") || "").trim();
        const parent = String(new FormData(form).get("parent") || "").trim();
        if (!["district", "zone", "area"].includes(list) || !S.catalog || !value) return;
        const c = structuredClone(S.catalog);
        const next = {
          districts: c.districts,
          zonesByDistrict: c.zonesByDistrict,
          areasByZone: c.areasByZone,
          packaging: c.packaging,
          products: c.products, // legacy field of the setting; product lists are the parcel products (Service plans)
          weightsKg: c.weightsKg,
        };
        const has = (items, v) => items.some(item => item.toLowerCase() === v.toLowerCase());
        if (list === "district") {
          if (has(next.districts, value)) return;
          next.districts.push(value);
          next.zonesByDistrict[value] = [];
        } else if (list === "zone") {
          if (!next.districts.includes(parent) || has(next.zonesByDistrict[parent] || [], value)) return;
          (next.zonesByDistrict[parent] ||= []).push(value);
        } else if (list === "area") {
          const zones = Object.values(next.zonesByDistrict).flat();
          if (!zones.includes(parent) || has(next.areasByZone[parent] || [], value)) return;
          (next.areasByZone[parent] ||= []).push(value);
        }
        stop(event);
        void busy(form.querySelector('[type="submit"]'), async () => {
          try {
            await DF.api("/catalog", { method: "PUT", body: next });
            await load("catalog", "audit");
            // The page adds the item to its own lists and saves the platform settings.
            if (list === "district" && geoCatalog.district.includes(value)) geoCatalog.district.splice(geoCatalog.district.indexOf(value), 1);
            if (list === "zone") geoHierarchy.zonesByDistrict[parent] = geoHierarchy.zonesByDistrict[parent].filter(z => z !== value);
            if (list === "area") geoHierarchy.areasByZone[parent] = geoHierarchy.areasByZone[parent].filter(a => a !== value);
            replay(form, "submit");
          } catch (error) {
            fail(error);
          }
        });
        return;
      }

      if (form.id !== "modalForm") return;
      const type = modalState.type;

      // Approve a merchant application.
      if (type === "registration") {
        stop(event);
        const m = byCode(modalState.id);
        if (!m) return;
        // Service packages replaced service plans: the choice is the merchant's package (empty = its category default).
        const packageId = document.getElementById("approvalPlan")?.value || null;
        void busy(document.getElementById("modalSubmit"), async () => {
          try {
            await DF.api(`/merchants/${m.id}`, { method: "PATCH", body: { status: "ACTIVE" } });
            let pending = false;
            if (packageId) pending = (await DF.api(`/merchants/${m.id}/package`, { method: "PUT", body: { packageId } }))?.status === "PENDING";
            decided.set(m.id, "Approved");
            await load("merchants", "overview", "audit");
            closeModal();
            showPage("Registrations");
            showToast(`${m.name}: approved · merchant account activated${pending ? " · package change sent for approval" : ""}.`);
          } catch (error) {
            fail(error);
          }
        });
        return;
      }

      // Merchant status (the service package changes on Service plans & pricing, with maker-checker).
      if (type === "merchant") {
        stop(event);
        const m = byCode(modalState.id);
        if (!m) return;
        const status = { Active: "ACTIVE", "Under review": "PENDING_REVIEW", Suspended: "SUSPENDED" }[document.getElementById("merchantStatus").value];
        const body = {};
        if (status !== m.status) body.status = status;
        if (!Object.keys(body).length) {
          closeModal();
          showToast(`No changes to ${m.name}.`);
          return;
        }
        const proceed = body.status === "SUSPENDED" ? DF.confirm({ title: `Suspend ${m.name}?`, message: "Its team can't book pickups until the account is reactivated.", confirm: "Suspend", danger: true }) : Promise.resolve(true);
        void proceed.then(ok => ok && busy(document.getElementById("modalSubmit"), async () => {
          try {
            await DF.api(`/merchants/${m.id}`, { method: "PATCH", body });
            await load("merchants", "overview", "audit");
            closeModal();
            showPage(currentPage);
            showToast(`${m.name} account changes saved.`);
          } catch (error) {
            fail(error);
          }
        }));
        return;
      }

      // Invite an administrator: creates the account; they sign in with an SMS code.
      if (type === "inviteAdmin") {
        stop(event);
        const name = document.getElementById("adminName").value.trim();
        const email = document.getElementById("adminEmail").value.trim();
        const mobile = document.getElementById("adminPhone").value.trim();
        const role = INVITE_ROLE[document.getElementById("adminRole").value];
        const hubId = document.getElementById("adminScope").value;
        if (role === "HUB_OPERATOR" && !hubId) return showToast("Choose the hub this Hub Manager runs.");
        const grant = role === "HUB_OPERATOR" ? { role, hubId } : { role };
        void busy(document.getElementById("modalSubmit"), async () => {
          try {
            await DF.api("/users", { method: "POST", body: { name, phone: mobile, email, roles: [grant] } });
            await load("staff", "overview", "audit");
            closeModal();
            showPage("Admin users");
            showToast(`${name} can now sign in with an SMS code sent to ${mobile}.`);
          } catch (error) {
            fail(error);
          }
        });
        return;
      }

      // Real invitations live in bridge-merchants.js.
      if (type === "inviteMerchant" && !window.DFMerchantAdmin) {
        stop(event);
        showToast(
          "Email invitations aren't available yet. Ask the business to apply from its Delivery Fast account; the application then appears here for review.",
        );
      }
    },
    true,
  );

  window.addEventListener(
    "click",
    event => {
      if (passThrough.has(event.target)) return;
      // Reject an application: the account stays without access (suspended).
      const reject = event.target.closest?.("[data-modal-reject]");
      // With bridge-merchants.js loaded, rejecting asks for a reason (POST /merchants/:id/reject).
      if (reject && !window.DFMerchantAdmin) {
        stop(event);
        const m = byCode(reject.dataset.modalReject);
        if (!m) return;
        void DF.confirm({ title: `Reject ${m.name}'s application?`, message: "The account will be suspended.", confirm: "Reject", danger: true }).then(ok => ok && busy(reject, async () => {
          try {
            await DF.api(`/merchants/${m.id}`, { method: "PATCH", body: { status: "SUSPENDED" } });
            decided.set(m.id, "Rejected");
            await load("merchants", "overview", "audit");
            closeModal();
            showPage("Registrations");
            showToast(`${m.name}: rejected · account access stays disabled.`);
          } catch (error) {
            fail(error);
          }
        }));
        return;
      }
      if (event.target.closest?.('[data-toast="Platform dashboard refreshed."]')) {
        stop(event);
        void refresh(true).then(() => showToast("Platform dashboard refreshed."), fail);
        return;
      }
      if (event.target.closest?.("[data-customer-parcel-refresh]")) {
        stop(event);
        void load("parcels").then(() => {
          showPage(currentPage);
          showToast("Customer parcel requests refreshed.");
        }, fail);
      }
    },
    true,
  );

  window.addEventListener(
    "change",
    event => {
      if (passThrough.has(event.target)) return;
      // Assign a merchant to a plan.
      const select = event.target.closest?.("[data-merchant-plan]");
      if (!select) return;
      event.stopImmediatePropagation();
      const m = byCode(select.dataset.merchantPlan);
      if (!m) return;
      void busy(select, async () => {
        try {
          const plan = await ensurePlan(select.dataset.merchantKind, select.value);
          await DF.api(`/merchants/${m.id}`, { method: "PATCH", body: { planId: plan.id } });
          await load("merchants", "plans", "audit");
          select.disabled = false;
          replay(select, "change");
        } catch (error) {
          fail(error);
          showPage(currentPage);
        }
      });
    },
    true,
  );

  // Account dialog → "Change" service package: the merchant's row on Service plans & pricing (bridge-packages.js).
  window.addEventListener(
    "click",
    event => {
      const button = event.target instanceof Element && event.target.closest("#merchantPackageChange");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const m = byCode(button.dataset.merchantCode);
      if (!m) return;
      closeModal();
      if (window.DFPackages) void window.DFPackages.openAssignment(m.type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE", m.code);
      else showPage("Service plans");
    },
    true,
  );

  // Admin users → "Manage": the staff member's account, with Suspend / Reactivate (PATCH /users/:id; suspending ends
  // their sessions at once). Rows follow S.staff (same order as adminUsers).
  function closeStaffDialog() {
    document.getElementById("dfStaffDialog")?.remove();
  }
  function openStaffDialog(u) {
    closeStaffDialog();
    const roles = u.roles.filter(r => STAFF_ROLES.includes(r.role));
    const status = u.status === "ACTIVE" ? (u.lastLoginAt ? "Active" : "Invited") : u.status === "SUSPENDED" ? "Suspended" : "Disabled";
    const self = DF.auth.user?.id === u.id;
    const row = (k, v) => `<div style="display:grid;grid-template-columns:140px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid #eef1f5"><span style="color:#778293">${escapeHtml(k)}</span><span>${v}</span></div>`;
    const action = self
      ? `<p class="panel-subtitle" style="margin:0">You can't suspend your own account.</p>`
      : u.status === "ACTIVE"
        ? `<button type="button" class="button" data-staff-close>Close</button><button type="button" class="button button-primary" data-staff-status="SUSPENDED" style="background:#c34d4d;border-color:#c34d4d">Suspend account</button>`
        : `<button type="button" class="button" data-staff-close>Close</button><button type="button" class="button button-primary" data-staff-status="ACTIVE">Reactivate account</button>`;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="dfStaffDialog" role="dialog" aria-modal="true" aria-labelledby="dfStaffTitle" style="position:fixed;inset:0;z-index:100;background:#14203380;display:grid;place-items:center;padding:18px">
        <section style="width:min(520px,100%);max-height:85vh;overflow:auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 24px 70px #10182840">
          <header style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:8px"><div><h2 id="dfStaffTitle" style="margin:0;font-size:18px">${escapeHtml(u.name)}</h2><p style="margin:4px 0 0;color:#778293">${escapeHtml(roles.map(r => ROLE_LABEL[r.role]).join(" · "))}</p></div>${statusPill(status)}</header>
          ${row("Mobile", escapeHtml(phone(u.phone)))}${row("Email", escapeHtml(u.email || "—"))}${row("Scope", escapeHtml([...new Set(roles.map(r => (r.role === "HUB_OPERATOR" ? r.hub?.name || "Hub" : ROLE_SCOPE[r.role])))].join(" · ")))}${row("Last sign-in", escapeHtml(u.lastLoginAt ? when(u.lastLoginAt) : "Not signed in yet"))}
          ${u.status === "ACTIVE" ? `<p class="panel-subtitle" style="margin:12px 0 0">Suspending signs ${escapeHtml(u.name)} out everywhere at once; they can't sign in until the account is reactivated.</p>` : `<p class="panel-subtitle" style="margin:12px 0 0">This account is ${escapeHtml(status.toLowerCase())}. Reactivating lets ${escapeHtml(u.name)} sign in again.</p>`}
          <div class="modal-actions" style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px">${action}</div>
        </section></div>`,
    );
    const box = document.getElementById("dfStaffDialog");
    box.addEventListener("click", event => {
      if (event.target === box || event.target.closest("[data-staff-close]")) return closeStaffDialog();
      const button = event.target.closest("[data-staff-status]");
      if (!button) return;
      const next = button.dataset.staffStatus;
      const confirmed = next === "SUSPENDED" ? DF.confirm({ title: `Suspend ${u.name}?`, message: "They are signed out everywhere and can't sign in until you reactivate the account.", confirm: "Suspend", danger: true }) : Promise.resolve(true);
      void confirmed.then(ok =>
        ok &&
        busy(button, async () => {
          try {
            await DF.api(`/users/${u.id}`, { method: "PATCH", body: { status: next } });
            await load("staff", "audit");
            closeStaffDialog();
            showPage("Admin users");
            showToast(next === "SUSPENDED" ? `${u.name} is suspended and signed out.` : `${u.name} can sign in again.`);
          } catch (error) {
            fail(error);
          }
        }),
      );
    });
  }
  window.addEventListener(
    "click",
    event => {
      const button = event.target instanceof Element && event.target.closest("#mainContent [data-admin]");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const u = S.staff[Number(button.dataset.admin)];
      if (u) openStaffDialog(u);
    },
    true,
  );

  // Service packages in the approval and account dialogs; a phone number and hubs when inviting an administrator.
  const baseOpenModal = window.openModal;
  window.openModal = openModal = function (type, id) {
    baseOpenModal(type, id);
    const m = (type === "registration" || type === "merchant") && byCode(id);
    if (m && type === "registration") {
      // The merchant's service package (spec v2): its category's default, or another active package.
      const select = document.getElementById("approvalPlan");
      const label = select.closest(".field")?.querySelector("label");
      if (label) label.textContent = "Service package";
      select.innerHTML = `<option value="">Default package</option>`;
      const segment = m.type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE";
      DF.api(`/packages?segment=${segment}`)
        .then(list => {
          const def = list.find(p => p.isDefault);
          select.innerHTML = [`<option value="">${escapeHtml(def ? `${def.name} (default)` : "Default package")}</option>`, ...list.filter(p => p.status === "ACTIVE" && !p.isDefault).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)].join("");
        })
        .catch(() => undefined);
    } else if (m) {
      // The account dialog: the service package the merchant books with now (and any scheduled change),
      // changed on Service plans & pricing where assignments go through maker-checker.
      const field = document.getElementById("merchantPlan")?.closest(".field");
      if (field)
        field.outerHTML = `<div class="field" id="merchantPackageField"><label for="merchantPackage">Service package</label><div style="display:flex;gap:8px;align-items:center"><input id="merchantPackage" value="${escapeHtml(packageLabel(m))}" readonly style="flex:1;min-width:0"><button type="button" class="button button-sm" id="merchantPackageChange" data-merchant-code="${escapeHtml(m.code)}" title="Assign another package (a second super admin approves)">Change</button></div><small class="panel-subtitle" id="merchantPackageNote" style="display:block;margin-top:4px"></small></div>`;
      document.getElementById("modalDescription").textContent = `${m.code} · account status and service package.`;
      document.getElementById("merchantNote")?.setAttribute("placeholder", "Reason for the status change");
      DF.api(`/merchants/${m.id}/package`)
        .then(p => {
          const input = document.getElementById("merchantPackage");
          if (!input || modalState.id !== m.code) return;
          input.value = `${p.current.name}${p.current.isDefault ? " (default)" : ""} · v${p.current.version}`;
          const next = p.scheduled[0];
          document.getElementById("merchantPackageNote").textContent = next ? `Changes to ${next.package?.name || "the default package"} on ${date(next.effectiveFrom)}.` : "";
        })
        .catch(() => undefined);
    }
    if (type === "inviteAdmin") {
      const email = document.getElementById("adminEmail").closest(".field");
      email.insertAdjacentHTML(
        "afterend",
        `<div class="field full"><label for="adminPhone">Mobile number</label><input id="adminPhone" type="tel" required placeholder="01XXXXXXXXX" autocomplete="tel"></div>`,
      );
      const scope = document.getElementById("adminScope");
      scope.innerHTML = `<option value="">Not hub-specific</option>${S.hubs
        .filter(h => h.active)
        .map(h => `<option value="${h.id}">${escapeHtml(h.name)}</option>`)
        .join("")}`;
    }
  };

  // ───────────── start and keep up to date ─────────────
  async function refresh(force = false) {
    const changed = await load("merchants", "overview", "audit", "staff", "riders", "parcels");
    const modalOpen = document.getElementById("modalBackdrop").classList.contains("open");
    const editing =
      document.activeElement &&
      document.getElementById("mainContent").contains(document.activeElement) &&
      document.activeElement.matches("input, select, textarea");
    if ((changed || force) && LIVE_PAGES.has(currentPage) && !modalOpen && !editing) showPage(currentPage);
  }

  // No sample records while the real ones load.
  for (const list of [registrations, merchants, adminUsers, auditEntries, activityRiders, platformActivityEvents, activityTrackingSamples])
    replaceAll(list, []);
  generic["Audit log"].rows = [];

  DF.bridgeReady = (async () => {
    try {
      await load(...Object.keys(loaders));
    } catch (error) {
      console.error("Super admin data could not be loaded", error);
      showToast(DF.describe(error));
    }
    // Links from other panels open a page: /super-admin?page=<menu page name> (e.g. Courier Operations › Settings).
    const linked = new URLSearchParams(location.search).get("page");
    const known = linked && [...document.querySelectorAll("#navigation [data-page]")].some(b => b.dataset.page === linked);
    showPage(known ? linked : "Overview");
  })();
  DF.poll(() => refresh(), 30000);
  // Geography / catalog changes (here or by another admin): the page's district, zone and area lists follow.
  DF.events.on("catalog.updated", () => void load("catalog").catch(() => undefined));
  /** For companion bridges (bridge-merchants.js): reload data sets and redraw the current page. */
  window.DFSuperAdminBridge = {
    reload: async (...names) => {
      await load(...names);
      showPage(currentPage);
    },
    page: () => currentPage,
  };
})();

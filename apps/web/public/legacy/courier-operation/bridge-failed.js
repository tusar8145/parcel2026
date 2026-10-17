/*
 * Courier Operations: failed deliveries. UI only, on read-only parcel fields from GET /parcels and
 * GET /parcels/:id: failedAttempts, lastFailedAttempt { reason, at, riderName }, returnedAfterFailure
 * and attempts (staff).
 *
 *   Badge             Ops.failureBadge(p): "Failed ×N · <last reason>" (red pill) on every parcel row
 *                     (bridge.js shipmentRows) and in the parcel drawer, which also lists the attempts
 *                     (Ops.failureSection: date, rider, reason, next step).
 *   Next actions      Back at a hub after a failed attempt, or retry scheduled: "Re-attempt (Assign rider)"
 *                     (the assign dialog → POST /parcels/:id/assign-delivery) and "Return to sender".
 *   Return to sender  Ops.returnToSender(id): Ops.form with the reason (prefilled from the last failure), a
 *                     note and "Add to a return run now" (no / a new run / an open run of the merchant). It
 *                     uses the existing steps: POST /parcels/:id/status RETURN_SCHEDULED, POST /returns/runs
 *                     or POST /returns/runs/:id/parcels (+ POST /parcels/:id/notes for the note), then shows
 *                     the result with a link to Returns.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const NO_BADGE = ["DELIVERED", "PICKUP_CANCELLED"];
  const NEXT_STEP = { RETRY: "Retry planned", RETURN_TO_HUB: "Back to hub" };
  const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  /** Failed delivery waiting for a decision: retry scheduled, or back at a hub after a failed attempt. */
  Ops.failedDelivery = p => !!p && (p.status === "RETRY_SCHEDULED" || !!p.returnedAfterFailure);
  const count = p => Number(p?.failedAttempts) || 0;

  /** One line about the failures: "Delivery failed ×2 · last 18 Oct, 3:10 PM by Karim: Recipient refused · back at the hub". */
  Ops.failureText = p => {
    const last = p.lastFailedAttempt;
    const by = last?.riderName ? ` by ${last.riderName}` : "";
    return `Delivery failed ×${count(p)}${last ? ` · last ${Ops.when(last.at)}${by}${last.reason ? `: ${last.reason}` : ""}` : ""}${p.returnedAfterFailure ? " · back at the hub" : p.status === "RETRY_SCHEDULED" ? " · retry scheduled" : ""}`;
  };

  /** The red pill, or "" (no failed attempt, or delivered / cancelled). */
  Ops.failureBadge = p => {
    if (!p || !count(p) || NO_BADGE.includes(p.status)) return "";
    const reason = p.lastFailedAttempt?.reason;
    return `<span class="status status-bad" data-failed-badge="${count(p)}" title="${esc(Ops.failureText(p))}" style="margin-left:4px;white-space:nowrap">${esc(`Failed ×${count(p)}${reason ? ` · ${cut(reason, 26)}` : ""}`)}</span>`;
  };

  /** The drawer's "Delivery attempts" section (every attempt, newest first), or "". */
  Ops.failureSection = p => {
    if (!count(p)) return "";
    const attempts = [...(p.attempts || [])].reverse();
    const rows = attempts.length
      ? attempts
          .map(
            a =>
              `<tr data-attempt="${esc(a.id)}"><td>${esc(Ops.when(a.at))}</td><td>${esc(a.rider ? `${a.rider.code} · ${a.rider.name}` : "—")}</td><td>${a.outcome === "FAILED" ? `<span class="status status-bad">Failed</span>` : `<span class="status status-good">Delivered</span>`} ${esc(a.reason || "")}${a.note ? `<div style="color:#8a94a3;font-size:12px">${esc(a.note)}</div>` : ""}</td><td>${esc(NEXT_STEP[a.nextAction] || "")}</td></tr>`,
          )
          .join("")
      : // Older parcels without the attempt list: the tracking events tell the story.
        (p.events || [])
          .filter(e => /failed/i.test(e.title))
          .reverse()
          .map(e => `<tr><td>${esc(Ops.when(e.at))}</td><td>${esc(e.actor || "—")}</td><td>${esc(e.description || e.title)}</td><td></td></tr>`)
          .join("");
    const banner = Ops.failedDelivery(p)
      ? `<p style="margin:0 0 8px;padding:9px 11px;border-radius:8px;background:var(--red-soft);color:var(--red);font-size:13px" data-failed-note>${esc(p.returnedAfterFailure ? `Back at ${p.currentHub?.name || "the hub"} after a failed delivery. Re-attempt with a rider or return it to the sender.` : "Delivery failed; another attempt is scheduled. Re-attempt with a rider or return it to the sender.")}</p>`
      : "";
    return `<section id="drawerAttempts"><h3>Delivery attempts (${count(p)} failed)</h3>${banner}<div class="table-scroll"><table style="font-size:13px"><thead><tr><th>DATE</th><th>RIDER</th><th>RESULT · REASON</th><th>NEXT</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty-state">No attempt details recorded.</td></tr>`}</tbody></table></div></section>`;
  };

  // ───────────── next actions ─────────────

  // Failed deliveries: the delivery assignment reads "Re-attempt (Assign rider)" (same dialog and API call).
  // It replaces "Add to transfer" too: the parcel already went out for delivery from this hub.
  const baseNext = Ops.nextAction;
  Ops.nextAction = p => {
    const next = baseNext(p);
    if (!Ops.failedDelivery(p) || p.incomplete || (next && next.kind !== "assign" && next.kind !== "transfer")) return next;
    return { kind: "assign", label: "Re-attempt (Assign rider)", title: `${Ops.failureText(p)}. Assign a delivery rider for another attempt.` };
  };

  /** The "Return to sender" button for a failed delivery (staff who dispatch), or "". */
  Ops.returnButton = p => {
    if (!Ops.failedDelivery(p) || !Ops.can("dispatch")) return "";
    return `<button type="button" class="button button-sm button-primary" data-return-sender="${esc(p.trackingId)}" title="Schedule the return to the sender, optionally on a return run">Return to sender</button>`;
  };

  // ───────────── Problems › Failed delivery: attempts and reason columns ─────────────

  const FAILED_LIST = '#mainContent [data-list="problems-failed"]';
  const STATUS_COLUMN = 5; // checkbox, tracking, merchant / recipient, destination, rider, STATUS, SLA, actions
  function failureColumns() {
    const host = document.querySelector(FAILED_LIST);
    if (!host) return;
    const head = host.querySelector("thead tr");
    if (head && !head.querySelector("[data-fail-col]"))
      head.children[STATUS_COLUMN]?.insertAdjacentHTML("beforebegin", `<th data-fail-col>ATTEMPTS</th><th data-fail-col>LAST FAILURE</th>`);
    for (const tr of host.querySelectorAll("tbody tr[data-shipment-id]:not([data-fail-cols])")) {
      tr.dataset.failCols = "1";
      const p = Ops.apiParcel(tr.dataset.shipmentId);
      const last = p?.lastFailedAttempt;
      const attempts = `<td data-fail-col="attempts"><strong>${esc(`×${count(p)}`)}</strong><span class="subcell">${esc(p?.returnedAfterFailure ? `Back at ${p.currentHub?.name || "hub"}` : p?.status === "RETRY_SCHEDULED" ? "Retry scheduled" : "")}</span></td>`;
      const reason = `<td data-fail-col="reason" style="white-space:normal;min-width:160px">${esc(last?.reason || "—")}<span class="subcell">${esc([last ? Ops.when(last.at) : "", last?.riderName].filter(Boolean).join(" · "))}</span></td>`;
      tr.children[STATUS_COLUMN]?.insertAdjacentHTML("beforebegin", attempts + reason);
    }
    const empty = host.querySelector("tbody [data-list-empty]");
    if (empty) empty.colSpan = 10;
  }
  let columnsQueued = false;
  new MutationObserver(() => {
    if (columnsQueued || !document.querySelector(FAILED_LIST)) return;
    columnsQueued = true;
    queueMicrotask(() => {
      columnsQueued = false;
      failureColumns();
    });
  }).observe($("mainContent") || document.body, { childList: true, subtree: true });

  // ───────────── return to sender ─────────────

  const NOT_NOW = "";
  const NEW_RUN = "new";

  async function openRuns(merchantId) {
    if (!merchantId) return [];
    try {
      return (await DF.api(`/returns/runs?status=PLANNED&merchantId=${encodeURIComponent(merchantId)}&limit=50`)).items || [];
    } catch {
      return [];
    }
  }

  Ops.returnToSender = async id => {
    if (!Ops.require("dispatch", "return parcels to the sender")) return;
    let p = Ops.apiParcel(id);
    try {
      p = await DF.api(`/parcels/${encodeURIComponent(id)}`);
      Ops.upsertParcels?.([p]);
    } catch (error) {
      if (!p) return void showToast(DF.describe(error));
    }
    const merchant = p.merchant;
    const runs = await openRuns(merchant?.id);
    const runOptions = merchant
      ? [
          { value: NOT_NOW, label: "No — schedule the return only (plan the run later on Returns)" },
          { value: NEW_RUN, label: "Yes — start a new return run" },
          ...runs.map(r => ({ value: r.id, label: `Yes — add to ${r.number} (planned, ${r.parcelCount} parcel${r.parcelCount === 1 ? "" : "s"})` })),
        ]
      : [];
    Ops.form({
      title: `Return to sender · ${p.trackingId}`,
      description: `${count(p) ? `${Ops.failureText(p)}. ` : ""}The parcel goes to Return scheduled and ${merchant ? `${merchant.name} is` : "the sender is"} notified.`,
      submit: "Return to sender",
      fields: [
        { id: "reason", domId: "rtsReason", label: "Reason", required: true, maxLength: 300, value: p.returnInfo?.reason || p.lastFailedAttempt?.reason || "Delivery attempts exhausted", hint: p.returnInfo?.reason ? "The return reason already recorded is kept." : "" },
        { id: "note", domId: "rtsNote", label: "Note", type: "textarea", rows: 2, maxLength: 500, placeholder: "e.g. Recipient refused twice; merchant agreed to take it back" },
        merchant
          ? { id: "run", domId: "rtsRun", label: "Add to a return run now", type: "select", options: runOptions, value: NOT_NOW, full: true, hint: "Return runs take a merchant's parcels back together (Returns page)." }
          : { id: "runInfo", label: "Return run", type: "static", value: "Website customer parcels aren't put on merchant return runs; the return is scheduled only." },
      ],
      validate: { reason: v => (v.length < 3 ? "Enter the reason (at least 3 characters)" : "") },
      onSubmit: async v => {
        const run = v.run || NOT_NOW;
        let result;
        let runNumber = "";
        const problems = error => (error?.details?.problems ? new Error(error.details.problems.map(x => `${x.trackingId}: ${x.message}`).join(" · ")) : error);
        if (run === NOT_NOW) {
          result = await DF.api(`/parcels/${encodeURIComponent(p.trackingId)}/status`, { method: "POST", body: { status: "RETURN_SCHEDULED", note: v.reason, expectedVersion: p.version } });
          Ops.upsertParcels?.([result]);
        } else if (run === NEW_RUN) {
          const created = await DF.api("/returns/runs", { method: "POST", body: { merchantId: merchant.id, trackingIds: [p.trackingId], reason: v.reason, note: v.note || undefined } }).catch(error => {
            throw problems(error);
          });
          runNumber = created.number;
        } else {
          const updated = await DF.api(`/returns/runs/${encodeURIComponent(run)}/parcels`, { method: "POST", body: { trackingIds: [p.trackingId], reason: v.reason } }).catch(error => {
            throw problems(error);
          });
          runNumber = updated.number;
        }
        // The note goes on the parcel's timeline (staff only); a new run also keeps it as the run's note.
        if (v.note) await DF.api(`/parcels/${encodeURIComponent(p.trackingId)}/notes`, { method: "POST", body: { note: `Return to sender: ${v.note}` } }).catch(() => undefined);
        await Ops.refresh?.().catch(() => undefined);
        const message = runNumber ? `${p.trackingId} is scheduled for return on ${runNumber}.` : `${p.trackingId} is scheduled for return to the sender.`;
        setTimeout(() => done(p.trackingId, message, runNumber), 0);
        return message;
      },
    });
  };

  /** The result, with the way to Returns (where runs are dispatched and completed). */
  function done(trackingId, message, runNumber) {
    Ops.form({
      title: "Return to sender scheduled",
      description: "",
      submit: "Done",
      fields: [
        {
          id: "result",
          domId: "rtsResult",
          label: "Result",
          type: "static",
          html: `<p style="margin:0 0 10px"><span class="status status-good">Return scheduled</span> ${esc(message)}</p><p style="margin:0 0 12px;color:#647184;font-size:13px">${esc(runNumber ? "Dispatch the run with a rider on the Returns page; the merchant confirms receipt when it's back." : "Plan a return run for it on the Returns page when the rider is ready to take it back.")}</p><button type="button" class="button button-sm button-primary" data-open-returns="${esc(trackingId)}">Open Returns</button>`,
        },
      ],
      onSubmit: async () => "",
    });
  }

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      if (!(t instanceof Element)) return;
      const ret = t.closest("[data-return-sender]");
      if (ret) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void Ops.returnToSender(ret.dataset.returnSender);
      }
      const open = t.closest("[data-open-returns]");
      if (open) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeModal(); // eslint-disable-line no-undef -- the console's modal (01.js)
        Ops.drawer?.close();
        Ops.navigate?.("Returns");
      }
    },
    true,
  );
})();

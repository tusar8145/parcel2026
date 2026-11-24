/**
 * Rider Manage › Riders: the company's riders; Rider Manage › Franchise riders: franchise hubs' riders (same page,
 * franchise mode: only franchise hubs). Add a rider (hubs, a
 * password to share by hand, the sign-in SMS off by default with its text shown first) and edit one: name, mobile,
 * email, the hubs they work for (several: the app works at the nearest), vehicle, zone, daily capacity, active,
 * a new password. API: GET /riders?company=true, POST /riders, PATCH /riders/:id.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { localPhone, num } from "@panel/lib/format";
import { openForm, type FormField, type FormValues } from "@panel/ui/dialogs";
import { accountFields, generatePassword, passwordProblem } from "@panel/ui/AccountFields";
import { Button, Loading, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toastError } from "@panel/ui/toast";
import { groupHubs } from "@/lib/admin";

interface HubRef {
  id: string;
  name: string;
  code: string;
  type?: string;
}
interface Rider {
  id: string;
  code: string;
  name: string;
  phone: string;
  email: string | null;
  vehicle: string;
  zone: string | null;
  status: string;
  active: boolean;
  dailyCapacity: number | null;
  hub: HubRef | null;
  hubs: HubRef[];
  openTasks?: number;
}

const VEHICLES: [string, string][] = [
  ["MOTORBIKE", "Motorbike"],
  ["BICYCLE", "Bicycle"],
  ["VAN", "Van"],
  ["ON_FOOT", "On foot"],
];
const vehicleLabel = (v: string) => VEHICLES.find(([k]) => k === v)?.[1] ?? v;
const STATUS: Record<string, [string, "good" | "warn" | "info"]> = { ONLINE: ["Online", "good"], ON_BREAK: ["On break", "warn"], OFFLINE: ["Offline", "info"] };

async function hubsFor(franchise: boolean) {
  return (await api<(HubRef & { active?: boolean; district?: string })[]>("/hubs").catch(() => [])).filter(h => (h.type === "FRANCHISE") === franchise && h.active !== false);
}

function riderFields(hubs: (HubRef & { district?: string })[], r?: Rider, franchise = false): FormField[] {
  return [
    { id: "s_rider", label: "Rider", type: "section", hint: "Who they are and how they ride." },
    { id: "name", label: "Name", required: true, full: true, maxLength: 120, value: r?.name ?? "" },
    { id: "vehicle", label: "Vehicle", type: "select", required: true, value: r?.vehicle ?? "MOTORBIKE", options: VEHICLES.map(([value, label]) => ({ value, label })) },
    { id: "zone", label: "Usual zone", maxLength: 80, value: r?.zone ?? "" },
    { id: "dailyCapacity", label: "Stops a day", type: "number", min: 1, max: 500, value: r?.dailyCapacity ?? "", hint: "Assignment suggestions. Empty: the network default." },
    { id: "s_hub", label: franchise ? "Franchise hub" : "Hubs", type: "section", hint: franchise ? "The franchise hub they work for." : "Where they pick up, deliver and hand over cash." },
    // A franchise rider: exactly one franchise hub.
    franchise
      ? {
          id: "hubIds",
          label: "Franchise hub",
          type: "select",
          required: true,
          value: r?.hubs[0]?.id ?? "",
          options: [{ value: "", label: "Choose the franchise hub" }, ...hubs.map(h => ({ value: h.id, label: `${h.name} (${h.code})` }))],
          hint: "A franchise rider works for one franchise hub only (its parcels and its cash).",
        }
      : {
      id: "hubIds",
      label: "Hubs",
      type: "checks",
      required: true,
      value: r ? r.hubs.map(h => h.id).join(",") : "",
      // Inside Dhaka, Dhaka sub-urban, Outside Dhaka (franchise hubs are left out; one a rider is already on shows last).
      options: groupHubs(hubs).flatMap(g => g.hubs.map(h => ({ value: h.id, label: `${h.name} (${h.code})`, group: g.label }))),
      hint: "Several hubs: the rider app works at the nearest one (cash is handed over there); parcels of any of them can be assigned to the rider.",
    },
    // Sign-in: the rider app's login (the password and the sign-in message follow when adding).
    { id: "s_login", label: "Sign-in account (login)", type: "section", boxed: true, hint: "They sign in to the rider app with this mobile number (or email)." },
    { id: "phone", label: "Mobile number (sign-in)", type: "phone", required: true, value: r ? localPhone(r.phone) : "", placeholder: "01XXXXXXXXX" },
    { id: "email", label: "Email (sign-in)", type: "email", value: r?.email ?? "" },
  ];
}

const hubIdsOf = (v: FormValues) => v.hubIds.split(",").filter(Boolean);

export function FranchiseRiders() {
  return <Riders franchise />;
}

export default function Riders({ franchise = false }: { franchise?: boolean; tab?: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["admin", "riders", franchise ? "franchise" : "company", q], queryFn: () => api<Rider[]>(`/riders?${franchise ? "franchise" : "company"}=true${q.trim().length >= 2 ? `&q=${encodeURIComponent(q.trim())}` : ""}`) });
  const companyHubs = () => hubsFor(franchise);
  const oneHub = (v: string) => (franchise && v.split(",").filter(Boolean).length > 1 ? "A franchise rider works for one franchise hub." : "");
  const reload = () => qc.invalidateQueries({ queryKey: ["admin", "riders"] });

  async function add() {
    const hubs = await companyHubs();
    await openForm({
      title: "Add rider",
      description: "The rider signs in to the rider app with this mobile number (a code by SMS, or the password you set).",
      submit: "Add rider",
      wide: true,
      fields: [
        ...riderFields(hubs, undefined, franchise),
        ...accountFields(v => ({ kind: "rider", name: v.name, hubId: hubIdsOf(v)[0] })),
      ],
      validate: { password: passwordProblem, hubIds: oneHub },
      onSubmit: async v => {
        {
          const made = await api<Rider & { messageSent: boolean }>("/riders", {
            method: "POST",
            body: {
              name: v.name,
              phone: v.phone,
              email: v.email || undefined,
              hubIds: hubIdsOf(v),
              vehicle: v.vehicle,
              zone: v.zone || undefined,
              dailyCapacity: v.dailyCapacity ? Number(v.dailyCapacity) : undefined,
              password: v.password || undefined,
              sendSms: v.sendSms === "true",
            },
          });
          void reload();
          return `${made.code} · ${made.name} added.${made.messageSent ? " The sign-in message was sent." : " No message was sent: share the sign-in details yourself."}`;
        }
      },
    });
  }

  async function edit(r: Rider) {
    const hubs = await companyHubs();
    // A franchise / inactive hub the rider is on still shows.
    for (const h of r.hubs) if (!hubs.some(x => x.id === h.id)) hubs.push(h);
    await openForm({
      title: `Edit ${r.code} · ${r.name}`,
      submit: "Save",
      wide: true,
      fields: [
        ...riderFields(hubs, r, franchise),
        { id: "active", label: "Active (can sign in and take parcels)", type: "checkbox", value: r.active, full: true },
        { id: "password", label: "New password", maxLength: 128, placeholder: "Leave empty to keep the current one", hint: "Share it with the rider yourself; it isn't sent." },
        {
          id: "passwordTools",
          label: "",
          type: "static",
          live: (_v, set) => (
            <button type="button" className="button sm" onClick={() => set("password", generatePassword())}>
              Generate a password
            </button>
          ),
        },
      ],
      validate: { password: passwordProblem, hubIds: oneHub },
      onSubmit: async v => {
        {
          await api(`/riders/${r.id}`, {
            method: "PATCH",
            body: {
              name: v.name,
              phone: v.phone,
              email: v.email || null,
              hubIds: hubIdsOf(v),
              vehicle: v.vehicle,
              zone: v.zone || null,
              dailyCapacity: v.dailyCapacity ? Number(v.dailyCapacity) : null,
              active: v.active === "true",
              ...(v.password ? { password: v.password } : {}),
            },
          });
          void reload();
          return `${r.code} saved.${v.password ? " Share the new password with the rider." : ""}`;
        }
      },
    });
  }

  const riders = list.data ?? [];
  return (
    <>
      <PageHeading
        eyebrow="Rider Manage"
        title={franchise ? "Franchise riders" : "Riders"}
        subtitle={franchise ? "Franchise hubs' riders: each works only for its franchise hub. Franchises also add and edit them in their own panel." : "The company's riders. Franchise hubs' riders are under Franchise riders."}
        actions={
          <Button variant="primary" icon="plus" onClick={() => void add()}>
            Add rider
          </Button>
        }
      />
      <Panel
        title={`${num(riders.length)} rider${riders.length === 1 ? "" : "s"}`}
        tools={<input className="input" type="search" placeholder="Search code, name or mobile" value={q} onChange={e => setQ(e.target.value)} style={{ width: 260 }} />}
      >
        {list.isLoading ? (
          <Loading rows={6} />
        ) : list.isError ? (
          <p className="faint" style={{ padding: 16 }}>
            {describe(list.error)}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rider</th>
                  <th>Hubs</th>
                  <th>Vehicle</th>
                  <th>Status</th>
                  <th className="num">Open tasks</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {riders.map(r => (
                  <tr key={r.id}>
                    <td>
                      <span className="strong">{`${r.code} · ${r.name}`}</span>
                      <span className="sub">{[localPhone(r.phone), r.email].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td>
                      {r.hubs.length ? (
                        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                          {r.hubs.map(h => (
                            <Pill key={h.id} tone={h.id === r.hub?.id && r.hubs.length > 1 ? "good" : "info"}>
                              {`${h.name}${h.id === r.hub?.id && r.hubs.length > 1 ? " · now" : ""}`}
                            </Pill>
                          ))}
                        </div>
                      ) : (
                        <span className="faint">No hub</span>
                      )}
                    </td>
                    <td>
                      {vehicleLabel(r.vehicle)}
                      {r.zone ? <span className="sub">{r.zone}</span> : null}
                    </td>
                    <td>{r.active ? <Pill tone={(STATUS[r.status] ?? ["", "info"])[1]}>{(STATUS[r.status] ?? [r.status])[0]}</Pill> : <Pill tone="warn">Inactive</Pill>}</td>
                    <td className="num">{num(r.openTasks ?? 0)}</td>
                    <td>
                      <Button size="sm" icon="edit" onClick={() => void edit(r).catch(toastError)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
                {!riders.length ? (
                  <tr>
                    <td colSpan={6} className="empty">
                      No riders found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

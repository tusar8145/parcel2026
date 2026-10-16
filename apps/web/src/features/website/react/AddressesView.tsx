"use client";

import { useEffect, useState } from "react";
import { df, describe, site, toast } from "./df";
import { AddressFields, addressBody, type AddressNames } from "./AddressFields";
import { FieldError, PhoneInput, Select, TextInput, e164, rules, useBusy, useForm, local10 } from "./form";

interface Address {
  id: string;
  role: "PICKUP" | "RECEIVER";
  category: "HOME" | "OFFICE" | "OTHER";
  contactName: string;
  phone: string;
  street: string;
  area: string | null;
  zone: string;
  district: string;
  lat: number | null;
  lng: number | null;
  isDefault: boolean;
}

const CATEGORY_LABEL = { HOME: "Home", OFFICE: "Office", OTHER: "Other" } as const;
const NAMES: AddressNames = { category: "addressCategory", district: "addressDistrict", zone: "addressZone", area: "addressArea", street: "addressStreet", lat: "addressLat", lng: "addressLng", search: "addressSearch" };

/** Address book: add, edit (with map pin), delete and set a default per role. */
export default function AddressesView() {
  const [rows, setRows] = useState<Address[] | null>(null);
  const [editing, setEditing] = useState<Address | "new" | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    df()
      .api<Address[]>("/me/addresses")
      .then(list => {
        setRows(list);
        df().setAddressBook(list); // the booking form's saved-address picker
      })
      .catch(err => setError(describe(err)));
  useEffect(() => {
    void load();
  }, []);

  const remove = async (a: Address) => {
    if (!confirm(`Delete the saved address for ${a.contactName}?`)) return;
    try {
      await df().api(`/me/addresses/${a.id}`, { method: "DELETE" });
      toast("Address deleted.");
      await load();
    } catch (err) {
      toast(describe(err));
    }
  };
  const makeDefault = async (a: Address) => {
    try {
      await df().api(`/me/addresses/${a.id}`, { method: "PATCH", body: { isDefault: true } });
      toast(`Default ${a.role === "PICKUP" ? "pickup" : "delivery"} address updated.`);
      await load();
    } catch (err) {
      toast(describe(err));
    }
  };

  if (editing)
    return (
      <AddressForm
        address={editing === "new" ? null : editing}
        onDone={async saved => {
          setEditing(null);
          if (saved) await load();
        }}
      />
    );

  return (
    <div className="route-card" data-addresses="1">
      <div className="account-head">
        <div>
          <h2>Saved addresses</h2>
          <p>Addresses you save here (and from your pickup requests) make booking quicker.</p>
        </div>
        <button className="button button-primary" type="button" onClick={() => setEditing("new")}>
          Add an address
        </button>
      </div>
      {error ? <p className="route-note">{error}</p> : null}
      {rows === null ? (
        <div className="customer-orders-empty">Loading your addresses…</div>
      ) : rows.length ? (
        <div className="customer-address-list">
          {rows.map(a => (
            <article className="customer-address-item" key={a.id} data-address-id={a.id}>
              <strong>
                {`${a.role === "PICKUP" ? "Pickup address" : "Delivery address"} · ${CATEGORY_LABEL[a.category]}`}
                {a.isDefault ? <span style={{ marginLeft: 8, fontSize: 12, color: "var(--green)" }}>{"Default"}</span> : null}
              </strong>
              <p>{`${a.contactName} · +880 ${local10(a.phone)}`}</p>
              <p>{[a.street, a.area, a.zone, a.district].filter(Boolean).join(", ")}</p>
              {a.lat !== null && a.lng !== null ? <p style={{ fontSize: 12 }}>{"📍 Map pin saved"}</p> : null}
              <p style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
                <button type="button" className="button button-quiet" onClick={() => setEditing(a)}>
                  Edit
                </button>
                {!a.isDefault ? (
                  <button type="button" className="button button-quiet" onClick={() => void makeDefault(a)}>
                    Set as default
                  </button>
                ) : null}
                <button type="button" className="button button-quiet" onClick={() => void remove(a)}>
                  Delete
                </button>
              </p>
            </article>
          ))}
        </div>
      ) : (
        <div className="customer-orders-empty">No saved addresses yet. Add one, or they will appear here after you submit a pickup request.</div>
      )}
    </div>
  );
}

function AddressForm({ address, onDone }: { address: Address | null; onDone: (saved: boolean) => void }) {
  const req = rules.required;
  const form = useForm(
    {
      addressRole: address?.role ?? "PICKUP",
      addressName: address?.contactName ?? "",
      addressPhone: address ? local10(address.phone) : "",
      addressCategory: address ? CATEGORY_LABEL[address.category] : "Home",
      addressDistrict: address?.district ?? "",
      addressZone: address?.zone ?? "",
      addressArea: address?.area ?? "",
      addressStreet: address?.street ?? "",
      addressLat: address?.lat != null ? String(address.lat) : "",
      addressLng: address?.lng != null ? String(address.lng) : "",
      addressSearch: "",
      addressDefault: address?.isDefault ? "1" : "",
    },
    {
      addressName: rules.length(1, 120, "Contact name"),
      addressPhone: rules.phone,
      addressDistrict: req("Choose a district"),
      addressZone: req("Choose a zone"),
      addressStreet: rules.length(1, 200, "Street"),
    },
  );
  const { busy, run } = useBusy();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    const v = form.values;
    const parts = addressBody(v, NAMES);
    const body = {
      role: v.addressRole,
      contactName: v.addressName.trim(),
      phone: e164(v.addressPhone),
      ...parts,
      area: parts.area ?? (address ? null : undefined),
      ...(address && !parts.lat ? { lat: null, lng: null } : {}),
      isDefault: v.addressDefault === "1",
    };
    void run(async () => {
      try {
        if (address) await df().api(`/me/addresses/${address.id}`, { method: "PATCH", body });
        else await df().api("/me/addresses", { method: "POST", body });
        toast(address ? "Address updated." : "Address saved.");
        await site()?.refreshAccount();
        onDone(true);
      } catch (err) {
        const { mapped } = form.showServerError(err, {
          contactName: "addressName",
          phone: "addressPhone",
          street: "addressStreet",
          zone: "addressZone",
          district: "addressDistrict",
          area: "addressArea",
        });
        if (!mapped) toast(describe(err));
      }
    });
  };

  return (
    <form ref={form.formRef} className="route-card route-form" data-form="address" data-react="1" noValidate onSubmit={submit}>
      <h2 className="field full">{address ? "Edit address" : "Add an address"}</h2>
      <div className="field">
        <label htmlFor="addressRole">Use for *</label>
        <Select
          bound={form.bind("addressRole")}
          options={[
            ["PICKUP", "Pickups (my address)"],
            ["RECEIVER", "Deliveries (a recipient)"],
          ]}
        />
      </div>
      <div className="field">
        <label htmlFor="addressName">Contact name *</label>
        <TextInput bound={form.bind("addressName")} error={form.error("addressName")} placeholder="Full name" autoComplete="name" />
        <FieldError id="addressName" message={form.error("addressName")} />
      </div>
      <div className="field">
        <label htmlFor="addressPhone">Phone number *</label>
        <PhoneInput bound={form.bind("addressPhone")} error={form.error("addressPhone")} />
        <FieldError id="addressPhone" message={form.error("addressPhone")} />
      </div>
      <AddressFields form={form} names={NAMES} label="Address" streetLabel="Street, house / apartment / unit" />
      <div className="field full">
        <label className="checkline">
          <input type="checkbox" checked={form.values.addressDefault === "1"} onChange={e => form.set("addressDefault", e.target.checked ? "1" : "")} />
          {" Use as my default address for this purpose"}
        </label>
      </div>
      <div className="route-actions">
        <span className="route-note">{"The map pin is optional and helps riders find the door."}</span>
        <div className="route-action-buttons">
          <button className="button button-quiet" type="button" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? "Please wait…" : "Save address"}
          </button>
        </div>
      </div>
    </form>
  );
}

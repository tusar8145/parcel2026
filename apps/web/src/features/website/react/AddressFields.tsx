"use client";

import { useEffect, useRef } from "react";
import { df, type Catalog } from "./df";
import { MapPin, matchOption, type Place } from "./geo";
import { FieldError, Select, TextInput } from "./form";
import { usePlaceFromAddress } from "@/shared/usePlaceFromAddress";

export const CATEGORIES = ["Home", "Office", "Other"] as const;

export function catalog(): Catalog {
  return (
    df().state.catalog ?? {
      districts: ["Dhaka North", "Dhaka Central", "Dhaka South", "Chattogram"],
      zonesByDistrict: {},
      areasByZone: {},
      packaging: ["Small carton", "Large carton", "Box", "Poly mailer"],
      products: [], // only the parcel products from GET /catalog
      weightsKg: [0.5, 1, 2, 5],
      serviceLevels: { REGULAR: "Regular", SAME_DAY: "Same day", EXPRESS: "Express" },
    }
  );
}

export const zonesOf = (district: string) => catalog().zonesByDistrict[district] ?? [];
export const areasOf = (zone: string) => catalog().areasByZone[zone] ?? [];

/** "Kaliganj (Gazipur)" → "kaliganj": zone names shared by several districts carry the district. */
const bare = (s: string) => s.toLowerCase().replace(/\s*\([^)]*\)$/, "").trim();

/**
 * The catalog district and zone of a found place: a zone named like the place's suburb / area in
 * a district matching the place's district ("Dhaka" also means Dhaka North / Central / South).
 */
export function placeInCatalog(place: Pick<Place, "district" | "zone" | "area">): { district: string; zone: string } | null {
  const c = catalog();
  const d = place.district?.trim().toLowerCase();
  const districts = d ? c.districts.filter(x => x.toLowerCase() === d || x.toLowerCase().startsWith(`${d} `)) : c.districts;
  for (const name of [place.zone, place.area]) {
    const n = name?.trim().toLowerCase();
    if (!n) continue;
    for (const district of districts) {
      const zone = (c.zonesByDistrict[district] ?? []).find(z => z.toLowerCase() === n || bare(z) === n);
      if (zone) return { district, zone };
    }
    for (const district of districts) {
      const zone = (c.zonesByDistrict[district] ?? []).find(z => (c.areasByZone[z] ?? []).some(a => a.toLowerCase() === n));
      if (zone) return { district, zone };
    }
  }
  return null;
}

/** Field names for one address block, e.g. { category: "requestPickupCategory", … }. */
export interface AddressNames {
  category: string;
  district: string;
  zone: string;
  area?: string;
  street: string;
  lat: string;
  lng: string;
  /** No longer shown: the full address does the finding (kept so existing forms still type-check). */
  search?: string;
}

type FormLike = {
  values: Record<string, string>;
  set: (name: any, value: string) => void;
  setValues: (fn: (v: any) => any) => void;
  bind: (name: any) => any;
  error: (name: any) => string;
};

/**
 * Category, the full address, district → zone (→ area), and a map pin. The full address does the finding in the
 * background: its district / zone / area are picked as it is typed (GET /catalog/place), and once typing stops the
 * pin is placed from it (GET /geo/search) unless the user placed the pin themselves.
 */
export function AddressFields({ form, names, label, streetLabel, streetPlaceholder = "e.g. Flat 4B, House 22, Road 7, Banani, Dhaka" }: { form: FormLike; names: AddressNames; label: string; streetLabel: string; streetPlaceholder?: string }) {
  const v = form.values;
  const zones = zonesOf(v[names.district]);
  const areas = names.area ? areasOf(v[names.zone]) : [];
  const pin = v[names.lat] && v[names.lng] ? { lat: Number(v[names.lat]), lng: Number(v[names.lng]) } : null;

  const applyPlace = (place: Place, movePin: boolean) => {
    form.setValues((current: Record<string, string>) => {
      const next = { ...current };
      const found = placeInCatalog(place);
      const district = found?.district || matchOption(catalog().districts, place.district, place.zone);
      if (district) next[names.district] = district;
      const zone = found?.zone || matchOption(zonesOf(next[names.district]), place.zone, place.area);
      if (zone) next[names.zone] = zone;
      if (names.area) {
        const area = matchOption(areasOf(next[names.zone]), place.area, place.street);
        if (area) next[names.area] = area;
      }
      if (place.street && !current[names.street]) next[names.street] = place.street;
      if (movePin) {
        next[names.lat] = String(place.lat);
        next[names.lng] = String(place.lng);
      }
      return next;
    });
  };

  // The pin follows the typed full address until the user moves it by hand.
  const pinnedByUser = useRef(false);
  const street = (v[names.street] ?? "").trim();
  useEffect(() => {
    if (pinnedByUser.current || street.length < 8) return;
    let stale = false;
    const timer = setTimeout(() => {
      df()
        .api<{ items: Place[] }>(`/geo/search?q=${encodeURIComponent(street)}&limit=1`)
        .then(r => {
          const place = r.items[0];
          if (stale || !place || pinnedByUser.current) return;
          form.setValues((c: Record<string, string>) => ({ ...c, [names.lat]: String(place.lat), [names.lng]: String(place.lng) }));
        })
        .catch(() => undefined);
    }, 900);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs for the typed address only
  }, [street]);

  // The street field holds the full address: its district / zone / area are picked from it as it is typed.
  usePlaceFromAddress(v[names.street] ?? "", place =>
    form.setValues((current: Record<string, string>) => {
      const next = { ...current };
      if (!place.district || !catalog().districts.includes(place.district)) return current;
      next[names.district] = place.district;
      const zone = place.zone && zonesOf(place.district).includes(place.zone) ? place.zone : "";
      next[names.zone] = zone;
      if (names.area) next[names.area] = place.area && zone && areasOf(zone).includes(place.area) ? place.area : "";
      return next;
    }),
  );

  return (
    <>
      <div className="field full">
        <span className="field-label">{`${label} category *`}</span>
        <div className="address-category-options" role="radiogroup" aria-label={`${label} category`}>
          {CATEGORIES.map((c, i) => (
            <label className="address-category-option" key={c}>
              <input id={i === 0 ? names.category : undefined} type="radio" name={names.category} value={c} checked={(v[names.category] || "Home") === c} onChange={() => form.set(names.category, c)} />
              {c}
            </label>
          ))}
        </div>
      </div>
      <div className="field full">
        <label htmlFor={names.street}>{`${streetLabel} *`}</label>
        <TextInput bound={form.bind(names.street)} error={form.error(names.street)} placeholder={streetPlaceholder} autoComplete="street-address" />
        <FieldError id={names.street} message={form.error(names.street)} />
      </div>
      <div className="field">
        <label htmlFor={names.district}>{`${label} district *`}</label>
        <Select
          bound={{
            ...form.bind(names.district),
            onChange: (e: { target: { value: string } }) =>
              form.setValues((c: Record<string, string>) => ({ ...c, [names.district]: e.target.value, [names.zone]: "", ...(names.area ? { [names.area]: "" } : {}) })),
          }}
          error={form.error(names.district)}
          options={catalog().districts}
          placeholder="Select district"
        />
        <FieldError id={names.district} message={form.error(names.district)} />
      </div>
      <div className="field">
        <label htmlFor={names.zone}>{`${label} zone *`}</label>
        <Select
          bound={{ ...form.bind(names.zone), onChange: (e: { target: { value: string } }) => form.setValues((c: Record<string, string>) => ({ ...c, [names.zone]: e.target.value, ...(names.area ? { [names.area]: "" } : {}) })) }}
          error={form.error(names.zone)}
          options={zones}
          placeholder={v[names.district] ? "Select zone" : "Choose a district first"}
        />
        <FieldError id={names.zone} message={form.error(names.zone)} />
      </div>
      {names.area ? (
        <div className="field">
          <label htmlFor={names.area}>{`${label} area`}</label>
          <Select bound={form.bind(names.area)} error={form.error(names.area)} options={areas} placeholder={areas.length ? "Select area" : "No areas listed (optional)"} />
          <FieldError id={names.area} message={form.error(names.area)} />
        </div>
      ) : null}
      <div className="field full">
        <MapPin
          value={pin}
          onChange={p => {
            pinnedByUser.current = true;
            form.setValues((c: Record<string, string>) => ({ ...c, [names.lat]: String(p.lat), [names.lng]: String(p.lng) }));
          }}
          onAddress={place => applyPlace(place, false)}
        />
      </div>
    </>
  );
}

/** The API's address parts from the form's values. */
export function addressBody(v: Record<string, string>, names: AddressNames) {
  return {
    category: v[names.category] || "Home",
    street: v[names.street].trim(),
    area: names.area ? v[names.area] || undefined : undefined,
    zone: v[names.zone],
    district: v[names.district],
    ...(v[names.lat] && v[names.lng] ? { lat: Number(v[names.lat]), lng: Number(v[names.lng]) } : {}),
  };
}

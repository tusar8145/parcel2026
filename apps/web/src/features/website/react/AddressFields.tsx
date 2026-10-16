"use client";

import { df, type Catalog } from "./df";
import { AddressSearch, MapPin, matchOption, type Place } from "./geo";
import { FieldError, Select, TextInput } from "./form";

export const CATEGORIES = ["Home", "Office", "Other"] as const;

export function catalog(): Catalog {
  return (
    df().state.catalog ?? {
      districts: ["Dhaka North", "Dhaka Central", "Dhaka South", "Chattogram"],
      zonesByDistrict: {},
      areasByZone: {},
      packaging: ["Small carton", "Large carton", "Box", "Poly mailer"],
      products: ["General merchandise", "Fragile item", "Clothing", "Electronics"],
      weightsKg: [0.5, 1, 2, 5],
      serviceLevels: { REGULAR: "Regular", SAME_DAY: "Same day", EXPRESS: "Express" },
    }
  );
}

export const zonesOf = (district: string) => catalog().zonesByDistrict[district] ?? [];
export const areasOf = (zone: string) => catalog().areasByZone[zone] ?? [];

/** Field names for one address block, e.g. { category: "requestPickupCategory", … }. */
export interface AddressNames {
  category: string;
  district: string;
  zone: string;
  area?: string;
  street: string;
  lat: string;
  lng: string;
  search: string;
}

type FormLike = {
  values: Record<string, string>;
  set: (name: any, value: string) => void;
  setValues: (fn: (v: any) => any) => void;
  bind: (name: any) => any;
  error: (name: any) => string;
};

/**
 * Category, district → zone (→ area), street, plus address search and a map pin.
 * District/zone/area come from the server catalog; a picked place fills what matches.
 */
export function AddressFields({ form, names, label, streetLabel, streetPlaceholder = "Street, house / apartment / unit" }: { form: FormLike; names: AddressNames; label: string; streetLabel: string; streetPlaceholder?: string }) {
  const v = form.values;
  const zones = zonesOf(v[names.district]);
  const areas = names.area ? areasOf(v[names.zone]) : [];
  const pin = v[names.lat] && v[names.lng] ? { lat: Number(v[names.lat]), lng: Number(v[names.lng]) } : null;

  const applyPlace = (place: Place, movePin: boolean) => {
    form.setValues((current: Record<string, string>) => {
      const next = { ...current };
      const district = matchOption(catalog().districts, place.district, place.zone);
      if (district) next[names.district] = district;
      const zone = matchOption(zonesOf(next[names.district]), place.zone, place.area);
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
        <label htmlFor={names.search}>Find the address</label>
        <AddressSearch id={names.search} onPick={place => applyPlace(place, true)} />
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
        <label htmlFor={names.street}>{`${streetLabel} *`}</label>
        <TextInput bound={form.bind(names.street)} error={form.error(names.street)} placeholder={streetPlaceholder} autoComplete="street-address" />
        <FieldError id={names.street} message={form.error(names.street)} />
      </div>
      <div className="field full">
        <MapPin
          value={pin}
          onChange={p => form.setValues((c: Record<string, string>) => ({ ...c, [names.lat]: String(p.lat), [names.lng]: String(p.lng) }))}
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

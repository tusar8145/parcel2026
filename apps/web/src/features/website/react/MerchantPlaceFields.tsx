"use client";

import { useState } from "react";
import { AddressSearch, MapPin, matchOption, type Place } from "./geo";
import { areasOf, catalog, placeInCatalog, zonesOf } from "./AddressFields";
import { FieldError, Select, TextInput } from "./form";
import { usePlaceFromAddress } from "@/shared/usePlaceFromAddress";

/** The area select's "Other" choice: the merchant types the area name instead. */
export const OTHER_AREA = "__other__";

/** Field names of one structured merchant address, e.g. prefix "biz" → bizDistrict, bizZone, … */
export const placeNames = (prefix: string) => ({
  district: `${prefix}District`,
  zone: `${prefix}Zone`,
  area: `${prefix}Area`,
  otherArea: `${prefix}OtherArea`,
  street: `${prefix}Street`,
  lat: `${prefix}Lat`,
  lng: `${prefix}Lng`,
  search: `${prefix}Search`,
});
export type PlaceNames = ReturnType<typeof placeNames>;

/** Inline rules for one address (same checks as the API: catalog district → zone → area or "Other", street). */
export function placeRules(n: PlaceNames, active: (all: Record<string, string>) => boolean) {
  return {
    [n.district]: (v: string, all: Record<string, string>) => (active(all) && !v ? "Choose the district" : ""),
    [n.zone]: (v: string, all: Record<string, string>) => (active(all) && !v ? (all[n.district] ? "Choose the thana / upazila" : "Choose the district first") : ""),
    [n.area]: (v: string, all: Record<string, string>) => (active(all) && all[n.zone] && !v && areasOf(all[n.zone]).length ? 'Choose the area, or "Other" and type it' : ""),
    [n.otherArea]: (v: string, all: Record<string, string>) => {
      if (!active(all) || all[n.area] !== OTHER_AREA) return "";
      const t = v.trim();
      return !t ? "Type the area name" : t.length < 2 ? "Use at least 2 characters" : t.length > 80 ? "Use at most 80 characters" : "";
    },
    [n.street]: (v: string, all: Record<string, string>) => {
      if (!active(all)) return "";
      const t = v.trim();
      return !t ? "Enter the house, road and flat" : t.length < 5 ? "Use at least 5 characters" : t.length > 300 ? "Use at most 300 characters" : "";
    },
  };
}

/** The API's place object from the form's values. */
export function placeBody(v: Record<string, string>, n: PlaceNames) {
  const other = v[n.area] === OTHER_AREA;
  return {
    district: v[n.district],
    zone: v[n.zone],
    ...(other ? { otherArea: v[n.otherArea].trim() } : v[n.area] ? { area: v[n.area] } : {}),
    street: v[n.street].trim(),
    ...(v[n.lat] && v[n.lng] ? { lat: Number(v[n.lat]), lng: Number(v[n.lng]) } : {}),
  };
}

/** API error paths ("business.zone") → field names. */
export const placePaths = (apiPrefix: string, n: PlaceNames) => ({
  [`${apiPrefix}.district`]: n.district,
  [`${apiPrefix}.zone`]: n.zone,
  [`${apiPrefix}.area`]: n.area,
  [`${apiPrefix}.otherArea`]: n.otherArea,
  [`${apiPrefix}.street`]: n.street,
  [`${apiPrefix}.lat`]: n.street,
  [`${apiPrefix}.lng`]: n.street,
  [apiPrefix]: n.district,
});

type FormLike = {
  values: Record<string, string>;
  setValues: (fn: (v: any) => any) => void;
  bind: (name: any) => any;
  error: (name: any) => string;
};

/**
 * District (searchable) → Thana / Upazila → Area (or "Other" + its name) → street, and an optional
 * map pin with address search. Lists come from the live catalog (GET /catalog).
 */
export function MerchantPlaceFields({ form, names: n, label }: { form: FormLike; names: PlaceNames; label: string }) {
  const v = form.values;
  const zones = zonesOf(v[n.district]);
  const areas = areasOf(v[n.zone]);
  const pin = v[n.lat] && v[n.lng] ? { lat: Number(v[n.lat]), lng: Number(v[n.lng]) } : null;
  const [showMap, setShowMap] = useState(false);
  const setMany = (patch: Record<string, string>) => form.setValues((c: Record<string, string>) => ({ ...c, ...patch }));

  const applyPlace = (place: Place, movePin: boolean) =>
    form.setValues((current: Record<string, string>) => {
      const next = { ...current };
      const found = placeInCatalog(place);
      const district = found?.district || matchOption(catalog().districts, place.district, place.zone);
      if (district && district !== current[n.district]) Object.assign(next, { [n.district]: district, [n.zone]: "", [n.area]: "", [n.otherArea]: "" });
      const zone = found?.zone || matchOption(zonesOf(next[n.district]), place.zone, place.area);
      if (zone && zone !== current[n.zone]) Object.assign(next, { [n.zone]: zone, [n.area]: "", [n.otherArea]: "" });
      const area = matchOption(areasOf(next[n.zone]), place.area, place.street);
      if (area && !next[n.area]) next[n.area] = area;
      if (place.street && !current[n.street]) next[n.street] = place.street;
      if (movePin) Object.assign(next, { [n.lat]: String(place.lat), [n.lng]: String(place.lng) });
      return next;
    });

  // The street field holds the full address: its district / thana / area are picked from it as it is typed.
  usePlaceFromAddress(v[n.street] ?? "", place =>
    form.setValues((current: Record<string, string>) => {
      if (!place.district || !catalog().districts.includes(place.district)) return current;
      const zone = place.zone && zonesOf(place.district).includes(place.zone) ? place.zone : "";
      const area = place.area && zone && areasOf(zone).includes(place.area) ? place.area : "";
      return { ...current, [n.district]: place.district, [n.zone]: zone, [n.area]: area, [n.otherArea]: "" };
    }),
  );

  return (
    <>
      <div className="field">
        <label htmlFor={n.district}>{`${label} district *`}</label>
        <Select
          bound={{ ...form.bind(n.district), onChange: (e: { target: { value: string } }) => setMany({ [n.district]: e.target.value, [n.zone]: "", [n.area]: "", [n.otherArea]: "" }) }}
          error={form.error(n.district)}
          options={catalog().districts}
          placeholder="Select district"
          search
        />
        <FieldError id={n.district} message={form.error(n.district)} />
      </div>
      <div className="field">
        <label htmlFor={n.zone}>{`${label} thana / upazila *`}</label>
        <Select
          bound={{ ...form.bind(n.zone), onChange: (e: { target: { value: string } }) => setMany({ [n.zone]: e.target.value, [n.area]: "", [n.otherArea]: "" }) }}
          error={form.error(n.zone)}
          options={zones}
          placeholder={v[n.district] ? "Select thana / upazila" : "Choose a district first"}
          disabled={!v[n.district]}
          search
        />
        <FieldError id={n.zone} message={form.error(n.zone)} />
      </div>
      <div className="field">
        <label htmlFor={n.area}>{areas.length ? `${label} area *` : `${label} area`}</label>
        <Select
          bound={form.bind(n.area)}
          error={form.error(n.area)}
          options={[...areas, [OTHER_AREA, "Other (type the area)"]]}
          placeholder={!v[n.zone] ? "Choose the thana / upazila first" : areas.length ? "Select area" : "No areas listed (optional)"}
          disabled={!v[n.zone]}
          search
        />
        <FieldError id={n.area} message={form.error(n.area)} />
      </div>
      <div className="field" hidden={v[n.area] !== OTHER_AREA}>
        <label htmlFor={n.otherArea}>{"Area name *"}</label>
        <TextInput bound={form.bind(n.otherArea)} error={form.error(n.otherArea)} placeholder="e.g. Shahjadpur Lane 3" autoComplete="off" />
        <FieldError id={n.otherArea} message={form.error(n.otherArea)} />
      </div>
      <div className="field full">
        <label htmlFor={n.street}>{"Full address *"}</label>
        <TextInput bound={form.bind(n.street)} error={form.error(n.street)} placeholder="e.g. House 12, Road 7, Flat 3B, Banani, Dhaka" autoComplete="street-address" />
        <FieldError id={n.street} message={form.error(n.street)} />
      </div>
      <div className="field full df-map-pin">
        <span className="field-label">{pin ? `Map pin (optional) · ${Number(v[n.lat]).toFixed(5)}, ${Number(v[n.lng]).toFixed(5)}` : "Map pin (optional)"}</span>
        {showMap || pin ? (
          <div style={{ display: "grid", gap: 8 }}>
            <AddressSearch id={n.search} onPick={place => applyPlace(place, true)} />
            <MapPin value={pin} onChange={p => setMany({ [n.lat]: String(p.lat), [n.lng]: String(p.lng) })} onAddress={place => applyPlace(place, false)} />
            {pin ? (
              <button type="button" className="button" style={{ justifySelf: "start" }} onClick={() => (setMany({ [n.lat]: "", [n.lng]: "" }), setShowMap(false))}>
                Remove the pin
              </button>
            ) : null}
          </div>
        ) : (
          <button type="button" className="button" style={{ justifySelf: "start" }} id={`${n.search}Open`} onClick={() => setShowMap(true)}>
            Find on the map / drop a pin
          </button>
        )}
      </div>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";

interface PricingRates {
  sameZone?: number;
  crossZone?: number;
  extraWeight?: number;
  sameDayFee?: number;
  serviceFees?: Record<string, number>;
}

interface PlatformConfig {
  customerParcelPricing?: PricingRates;
  deliveryRates?: PricingRates;
}

export default function PricingSection({ legacy = false }: { legacy?: boolean }) {
  const [config, setConfig] = useState<PlatformConfig>({});
  const [zone, setZone] = useState("city");
  const [weight, setWeight] = useState(1);
  const [priority, setPriority] = useState(false);
  const [ratesReady, setRatesReady] = useState(legacy);

  useEffect(() => {
    if (legacy) return;

    let active = true;
    const loadRates = async () => {
      try {
        const response = await fetch("/api/v1/settings/platform-config");
        if (response.status === 404) return;
        if (!response.ok) throw new Error(`Platform pricing request failed (${response.status})`);
        const result = (await response.json()) as PlatformConfig;
        if (active) setConfig(result);
      } catch (error) {
        console.error("Website pricing configuration could not be loaded.", error);
      } finally {
        if (active) setRatesReady(true);
      }
    };
    void loadRates();
    return () => {
      active = false;
    };
  }, [legacy]);

  useEffect(() => {
    if (!legacy && ratesReady) document.documentElement.dataset.websiteReady = "true";
  }, [legacy, ratesReady]);

  const rates = config.customerParcelPricing ?? config.deliveryRates ?? {};
  const base = Number((zone === "city" ? rates.sameZone : rates.crossZone) ?? (zone === "city" ? 70 : 120));
  const extra = Math.max(0, Math.ceil(weight - 1)) * Number(rates.extraWeight ?? 20);
  const priorityFee = priority ? Number(rates.sameDayFee ?? rates.serviceFees?.["Same day"] ?? 30) : 0;
  const total = base + extra + priorityFee;

  return (
    <section className="split-section" id="pricing">
      {" "}
      <div className="shell split-grid">
        {" "}
        <div className="split-copy">
          <p className="eyebrow">Clear rates, before you book</p>
          <h2>
            Know the price.
            <br />
            Send with confidence.
          </h2>
          <p>
            Choose a service, delivery area, and parcel weight. Get an instant sample estimate with no surprises at
            pickup.
          </p>
          <div className="benefits">
            <div className="benefit">
              <i className="check">✓</i>
              <span>Transparent starting rates for domestic and inter-city delivery</span>
            </div>
            <div className="benefit">
              <i className="check">✓</i>
              <span>Optional cash-on-delivery collection for ecommerce parcels</span>
            </div>
            <div className="benefit">
              <i className="check">✓</i>
              <span>Shipment tracking included with every booking</span>
            </div>
          </div>
          <small style={{ color: "#84928c", fontSize: "13px" }}>
            Demo estimates only. Final rates may vary by area and service.
          </small>
        </div>{" "}
        <div className="calculator">
          <div className="calculator-top">
            <div>
              <h3>Quick price estimate</h3>
              <p>Adjust the options to see an estimate.</p>
            </div>
            <span className="price-label">৳ BDT</span>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="priceService">Delivery type</label>
              <select id="priceService">
                <option value="customer">Customer parcel</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="priceZone">Delivery area</label>
              <select
                id="priceZone"
                value={legacy ? undefined : zone}
                defaultValue={legacy ? "city" : undefined}
                onChange={legacy ? undefined : event => setZone(event.target.value)}
              >
                <option value="city">Same city</option>
                <option value="intercity">Inter-city</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="priceWeight">Parcel weight</label>
              <select
                id="priceWeight"
                value={legacy ? undefined : weight}
                defaultValue={legacy ? "1" : undefined}
                onChange={legacy ? undefined : event => setWeight(Number(event.target.value))}
              >
                <option value="0.5">Up to 0.5 kg</option>
                <option value="1">Up to 1 kg</option>
                <option value="2">Up to 2 kg</option>
                <option value="5">Up to 5 kg</option>
              </select>
            </div>
            <div className="field">
              <span>Cash on delivery</span>
              <label className="checkline">
                <input id="priceCod" type="checkbox" />
                {" Collect payment from recipient"}
              </label>
            </div>
            <div className="field" id="priceCodAmountField" hidden>
              <label htmlFor="priceCodAmount">Cash to collect (৳)</label>
              <input
                id="priceCodAmount"
                type="number"
                min="0"
                step="1"
                defaultValue="0"
                inputMode="numeric"
                placeholder="Enter COD amount"
              />
            </div>
            <div className="field full">
              <label className="checkline">
                <input
                  id="pricePriority"
                  type="checkbox"
                  checked={legacy ? undefined : priority}
                  defaultChecked={legacy ? false : undefined}
                  onChange={legacy ? undefined : event => setPriority(event.target.checked)}
                />
                {" Add priority handling where available"}
              </label>
            </div>
          </div>
          <div className="price-result">
            <div>
              <small>Estimated delivery charge</small>
              <strong id="priceTotal">৳ {total}</strong>
            </div>
            <span id="priceBreakdown">
              {legacy
                ? "Base ৳70 · Weight ৳0 · COD fee ৳0 · Priority ৳0"
                : `Base ৳${base} · Weight ৳${extra} · COD not available · Priority ৳${priorityFee}`}
            </span>
          </div>
        </div>{" "}
      </div>{" "}
    </section>
  );
}

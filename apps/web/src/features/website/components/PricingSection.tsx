export default function PricingSection() {
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
              <select id="priceZone">
                <option value="city">Same city</option>
                <option value="intercity">Inter-city</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="priceWeight">Parcel weight</label>
              <select id="priceWeight" defaultValue={"1"}>
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
                <input id="pricePriority" type="checkbox" />
                {" Add priority handling where available"}
              </label>
            </div>
          </div>
          <div className="price-result">
            <div>
              <small>Estimated delivery charge</small>
              <strong id="priceTotal">৳ 70</strong>
            </div>
            <span id="priceBreakdown">Base ৳70 · Weight ৳0 · COD fee ৳0 · Priority ৳0</span>
          </div>
        </div>{" "}
      </div>{" "}
    </section>
  );
}

import { permanentRedirect } from "next/navigation";

/** The document merchant panel is now the Banking & Financial merchant panel. */
export default function DocumentMerchantRedirect() {
  permanentRedirect("/banking-merchant");
}

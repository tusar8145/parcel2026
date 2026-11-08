/** Text the classic panel showed (shared/api.js, merchant-address.js). */
import { addressText } from "@panel/lib/format";

/** +8801712345678 → +880 1712-345678 */
export const phoneText = (p?: string | null) => {
  const m = /^\+880(\d{4})(\d{6})$/.exec(String(p || ""));
  return m ? `+880 ${m[1]}-${m[2]}` : p || "";
};
/** "House 7, Road 4, Gulshan, Dhaka North" (DFMerchantAddress.placeText). */
export const placeText = (p?: { street?: string | null; area?: string | null; zone?: string | null; district?: string | null } | null) => (p ? addressText(p.street, p.area, p.zone, p.district) : "");

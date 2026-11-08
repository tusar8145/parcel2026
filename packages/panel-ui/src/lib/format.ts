/** Formatting shared by every view (same output as DFOps.money / num / when / ago in the legacy panel). */
export const money = (n: unknown) => `৳ ${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
export const num = (n: unknown) => Number(n || 0).toLocaleString("en-US");
export const when = (iso?: string | Date | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
export const date = (iso?: string | Date | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const dateTime = (iso?: string | Date | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "—";
export const dayKey = (iso?: string | Date | null) => {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const ago = (iso?: string | Date | null) => {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hr ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};
export const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
/** Bangladesh phone as people write it: +8801711000000 → 01711000000. */
export const localPhone = (phone?: string | null) => (phone ? String(phone).replace(/^\+?880/, "0") : "");
/** Every address is shown exactly as typed (the street holds the full address). */
export const addressText = (street?: string | null, ...places: (string | null | undefined)[]) =>
  String(street || "").trim() || places.filter(Boolean).join(", ");
export const slug = (text: string) =>
  String(text)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

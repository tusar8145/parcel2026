/**
 * The message a new account gets when super admin (or operations) creates it: riders and franchise partners get
 * "account.invite" (sign in at /login), merchants "merchant.invite" (their application link). Sent only when the
 * form's "Send SMS" switch is on; the form shows the SMS text first (POST /accounts/invite-preview).
 */
import { env } from "../../config/env";

export type InviteKind = "rider" | "franchise" | "merchant" | "merchant_onboard";

export const loginLink = () => `${env().APP_URL.replace(/\/+$/, "")}/login`;
export const merchantInviteLink = (token: string) => `${env().APP_URL.replace(/\/+$/, "")}/merchant?invite=${encodeURIComponent(token)}`;

/** The event and its variables for a new account's message. */
export function inviteMessage(
  kind: InviteKind,
  input: { inviter: string; name?: string; hubName?: string | null; code?: string | null; franchiseName?: string | null; businessName?: string | null; merchantType?: string | null; link?: string },
): { event: "account.invite" | "merchant.invite" | "merchant.approved"; vars: Record<string, string> } {
  // Onboarded directly: the "approved, sign in" message.
  if (kind === "merchant_onboard") return { event: "merchant.approved", vars: { name: input.name ?? "", businessName: input.businessName || "Your business", link: input.link ?? loginLink() } };
  if (kind === "merchant")
    return {
      event: "merchant.invite",
      vars: {
        name: input.name ?? "",
        role: `${input.merchantType === "BANKING_FINANCIAL" ? "a Banking & Financial" : "an E-commerce"} merchant${input.businessName ? ` (${input.businessName})` : ""}`,
        link: input.link ?? `${env().APP_URL.replace(/\/+$/, "")}/merchant?invite=…`,
      },
    };
  const role =
    kind === "rider"
      ? `rider${[input.code, input.hubName].filter(Boolean).length ? ` (${[input.code, input.hubName].filter(Boolean).join(", ")})` : ""}`
      : `franchise partner${[input.franchiseName, input.hubName].filter(Boolean).length ? ` (${[input.franchiseName, input.hubName].filter(Boolean).join(", ")})` : ""}`;
  return { event: "account.invite", vars: { name: input.name ?? "", inviter: input.inviter, role, link: input.link ?? loginLink() } };
}

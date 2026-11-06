import { revalidateTag } from "next/cache";
import { SITE_CACHE_TAG } from "@/features/website/siteContent";

/**
 * Clears the public pages' cache after Super admin saves their content, so the next visit shows it.
 * The API decides who may: the caller's token must be able to open the website settings.
 */
export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return new Response(null, { status: 401 });
  const check = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}/api/v1/website/admin`, { headers: { authorization }, cache: "no-store" }).catch(() => null);
  if (!check?.ok) return new Response(null, { status: check?.status === 403 ? 403 : 401 });
  revalidateTag(SITE_CACHE_TAG, { expire: 0 });
  return new Response(null, { status: 204 });
}

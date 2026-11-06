const ASSET_VERSIONS: Record<string, string> = JSON.parse(process.env.LEGACY_ASSET_VERSIONS || "{}");

/** A legacy script's URL with its content version, so the browser can cache it for good. */
export function versioned(src: string) {
  const version = ASSET_VERSIONS[src];
  return version ? `${src}?v=${version}` : src;
}

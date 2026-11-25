/**
 * The Delivery Fast logo, everywhere (website, panels, rider app). `size` is the width in pixels; `light` is
 * the version with white lettering, for dark backgrounds. An uploaded logo replaces it: drawn by the server where the
 * page knows it (`logo`, the website), so nothing moves; elsewhere once the page has loaded (branding/runtime.ts).
 */
export default function BrandMark({ size = 190, light = false, logo }: { size?: number; light?: boolean; logo?: { url: string; alt: string } | null }) {
  if (logo) return <img src={logo.url} alt={logo.alt} data-brand-logo="1" style={{ display: "block", width: "auto", height: "auto", maxWidth: size, maxHeight: 44 }} />;
  return (
    <img
      src={light ? "/brand/logo-light.png" : "/brand/logo.png"}
      alt="Delivery Fast"
      width={size}
      height={Math.round((size * 90) / 527)}
      data-brand-mark="logo"
      style={{ display: "block" }}
    />
  );
}

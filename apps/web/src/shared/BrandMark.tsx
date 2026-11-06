/**
 * The Delivery Fast logo, everywhere (website, panels, rider app). `size` is the width in pixels; `light` is
 * the version with white lettering, for dark backgrounds. An uploaded logo replaces it (branding/runtime.ts).
 */
export default function BrandMark({ size = 190, light = false }: { size?: number; light?: boolean }) {
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

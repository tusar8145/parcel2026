/**
 * The Delivery Fast logo mark, everywhere (website, panels, rider app): a big pigeon in flight carrying a letter
 * in its claws to deliver. `size` is the width in pixels (the height follows the 36:32 drawing).
 */
export default function BrandMark({ size = 44 }: { size?: number }) {
  return (
    <svg viewBox="0 0 36 32" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-brand-mark="pigeon" style={{ width: size, height: Math.round((size * 32) / 36) }}>
      {/* The pigeon, drawn large: wings up in flight. */}
      <g transform="translate(-1.2 -0.6) scale(1.2)">
        {/* Far wing, raised high (behind the body). */}
        <path d="M14.2 12.6C12.4 7.4 14.4 2.9 20.4 1.2c-1.2 3.9-.4 7.6 2.4 10.6Z" fill="currentColor" opacity=".55" />
        {/* Near wing, swept up and back, its feathers in yellow. */}
        <path d="M11.6 13.2C9.2 9.4 9.6 5.2 13.4 2.2c.3 3.9 2 7.1 5.4 9.6Z" fill="currentColor" />
        <path d="M12.3 7.4c.5 1.6 1.4 2.9 2.7 4M11.4 10.1c.8 1.2 1.9 2.1 3.2 2.7" stroke="#fcc118" strokeWidth=".8" />
        {/* Tail fan. */}
        <path d="M2.4 12.4 8 14.6 2.8 17.2Z" fill="currentColor" />
        {/* Plump body: round chest, small head. */}
        <path d="M7.2 14.6c2.2-2.6 6.6-3.4 11-2.6 2.2.4 3.8-.2 5-1.3 1.4-1.3 3.6-1 4.3.5l1.8.7-1.8.9c-.3 1.3-.9 2.4-1.9 3.3-1.9 1.9-5 2.9-8.7 2.9-4.3 0-7.6-1.2-9.7-4.4Z" fill="currentColor" />
        {/* Beak, eye, neck sheen. */}
        <path d="M27.5 11.2 30.4 11.9 27.6 12.8Z" fill="#fcc118" />
        <circle cx="25.8" cy="11.1" r=".75" fill="#fff" />
        <path d="M23.4 13.2c.9.3 1.8.3 2.6 0" stroke="#fcc118" strokeWidth=".7" opacity=".8" />
        {/* Legs reaching down to the letter. */}
        <path d="M16 18.3 15.7 19.6M19.2 18.3l.2 1.3" stroke="currentColor" strokeWidth="1" />
      </g>
      {/* The letter, held in the claws, tilted as it's carried. */}
      <g transform="rotate(-8 22 27)">
        <rect x="15.6" y="22.6" width="12.4" height="8.4" rx="1.3" fill="#fff8df" stroke="#fcc118" strokeWidth="1.6" />
        <path d="M16 23.1 21.8 27.4 27.6 23.1" stroke="#fcc118" strokeWidth="1.3" />
      </g>
    </svg>
  );
}

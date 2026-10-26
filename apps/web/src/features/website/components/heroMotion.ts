/**
 * The hero picture's 10-second loop (Hero.tsx): morning — the parcel goes into the van, the van drives to the
 * house and the parcel appears at the door — the sun sets, night with a moon and stars while the van drives
 * off — dawn: the sun rises, the van comes back and a new parcel waits.
 *
 * Frame 0 (and 100%) is the original picture, so the design-reference parity test (which freezes animations
 * at frame 0) still matches; it copies this style block and the night / moon layers onto the reference page.
 * The van and parcel move with `translate` / `scale` (not `transform`), so the mobile layout's own transforms
 * stay. Visitors who ask for less motion see the still picture.
 */
export const HERO_MOTION_CSS = `
.hero-art{--door-x:282px;--van-stop:118px}
@media(max-width:700px){.hero-art{--door-x:178px;--van-stop:64px}}
/* The parcel's statuses, one by one, each check turning green (hidden in the still picture). */
.hero-art .art-steps{position:absolute;left:26px;top:54px;display:grid;gap:7px;pointer-events:none}
@media(max-width:700px){.hero-art .art-steps{left:15px;top:22px;gap:5px}}
.hero-art .art-step{display:flex;align-items:center;gap:8px;padding:6px 11px 6px 8px;border:1px solid #ebf0e9;border-radius:999px;background:#ffffffe0;box-shadow:0 8px 20px #294b3214;font-size:12.5px;color:#41544f;white-space:nowrap;opacity:0;translate:0 -6px}
.hero-art .art-step strong{color:#1f3b35;font-weight:750}
.hero-art .art-step i{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;border:1.6px solid #b9c9c1;background:#fff;color:transparent;font-style:normal;font-size:11px;font-weight:900;line-height:1}
.hero-art .art-step.s0{animation:dfStep0 10s ease-out infinite}
.hero-art .art-step.s1{animation:dfStep1 10s ease-out infinite}
.hero-art .art-step.s2{animation:dfStep2 10s ease-out infinite}
.hero-art .art-step.s3{animation:dfStep3 10s ease-out infinite}
.hero-art .art-step.s0 i{animation:dfCheck0 10s linear infinite}
.hero-art .art-step.s1 i{animation:dfCheck1 10s linear infinite}
.hero-art .art-step.s2 i{animation:dfCheck2 10s linear infinite}
.hero-art .art-step.s3 i{animation:dfCheck3 10s linear infinite}
/* In step with the van: confirmed while it waits, picked up as the parcel goes in (12–21%), out for delivery as it
   drives off (23%), delivered as the parcel reaches the door (49–55%); gone at the end of the night. */
@keyframes dfStep0{0%,2%{opacity:0;translate:0 -6px}5%,84%{opacity:1;translate:0 0}90%,100%{opacity:0;translate:0 0}}
@keyframes dfStep1{0%,10%{opacity:0;translate:0 -6px}13%,84%{opacity:1;translate:0 0}90%,100%{opacity:0;translate:0 0}}
@keyframes dfStep2{0%,21%{opacity:0;translate:0 -6px}24%,84%{opacity:1;translate:0 0}90%,100%{opacity:0;translate:0 0}}
@keyframes dfStep3{0%,42%{opacity:0;translate:0 -6px}45%,84%{opacity:1;translate:0 0}90%,100%{opacity:0;translate:0 0}}
@keyframes dfCheck0{0%,6%{background:#fff;border-color:#b9c9c1;color:transparent}8%,100%{background:#0b8a6c;border-color:#0b8a6c;color:#fff}}
@keyframes dfCheck1{0%,19%{background:#fff;border-color:#b9c9c1;color:transparent}21%,100%{background:#0b8a6c;border-color:#0b8a6c;color:#fff}}
@keyframes dfCheck2{0%,25%{background:#fff;border-color:#b9c9c1;color:transparent}27%,100%{background:#0b8a6c;border-color:#0b8a6c;color:#fff}}
@keyframes dfCheck3{0%,52%{background:#fff;border-color:#b9c9c1;color:transparent}54%,100%{background:#0b8a6c;border-color:#0b8a6c;color:#fff}}
/* "All the way, tracked" sits lower, clear of the house and the van. */
.hero-art .tag-bottom{bottom:12px}
@media(max-width:700px){.hero-art .tag-bottom{bottom:8px}}
.hero-art .art-sun{animation:dfSun 10s ease-in-out infinite}
.hero-art .art-box{animation:dfBox 10s ease-in-out infinite}
.hero-art .art-van{animation:dfVan 10s ease-in-out infinite}
.hero-art .art-night{position:absolute;inset:0;background:#0f1f3a;opacity:0;pointer-events:none;animation:dfNight 10s linear infinite}
.hero-art .art-moon{position:absolute;top:34px;left:44%;width:34px;height:34px;border-radius:50%;background:#f5f1d8;box-shadow:inset -9px -4px 0 #d9d2ae,0 0 22px #f5f1d866;opacity:0;pointer-events:none;animation:dfMoon 10s ease-in-out infinite}
.hero-art .art-moon:after{content:"";position:absolute;left:0;top:0;width:2px;height:2px;border-radius:50%;background:#fff;box-shadow:-120px 70px #fff,-60px 30px #fffc,60px 16px #fff,120px 50px #fffa,170px 6px #fff,-150px 120px #fff9,90px 110px #fffb,-30px 140px #fff8}
/* The info cards stay readable at night: a light card behind their text (none in the still picture). */
.hero-art .float-tag{animation:dfTag 10s linear infinite}
@keyframes dfSun{
  0%,48%{translate:0 0;background-color:#d3ed9a}
  60%{translate:-30px 120px;background-color:#f4a261}
  68%,86%{translate:-40px 310px;background-color:#f4a261}
  94%{translate:0 90px;background-color:#f7c873}
  100%{translate:0 0;background-color:#d3ed9a}
}
@keyframes dfBox{
  0%,12%{translate:0 0;scale:1;opacity:1}
  21%{translate:118px -6px;scale:.45;opacity:0}
  49%{translate:var(--door-x) 4px;scale:.5;opacity:0}
  55%,80%{translate:var(--door-x) 4px;scale:.5;opacity:1}
  85%{translate:var(--door-x) 4px;scale:.5;opacity:0}
  88%{translate:0 0;scale:1;opacity:0}
  95%,100%{translate:0 0;scale:1;opacity:1}
}
@keyframes dfVan{
  0%,20%{translate:0 0;opacity:1}
  23%{translate:0 -2px}
  45%,54%{translate:var(--van-stop) 0;opacity:1}
  74%{translate:560px 0;opacity:1}
  74.5%{translate:560px 0;opacity:0}
  75%{translate:-460px 0;opacity:0}
  80%{translate:-460px 0;opacity:1}
  97%{translate:6px 0}
  100%{translate:0 0;opacity:1}
}
@keyframes dfNight{
  0%,50%{opacity:0;background:#f59e0b}
  58%{opacity:.18;background:#f59e0b}
  66%,84%{opacity:.5;background:#0f1f3a}
  92%{opacity:.14;background:#fbbf24}
  100%{opacity:0;background:#fbbf24}
}
@keyframes dfTag{
  0%,54%{background-color:transparent}
  64%,86%{background-color:#ffffffeb}
  95%,100%{background-color:transparent}
}
@keyframes dfMoon{
  0%,62%{opacity:0;translate:0 14px}
  70%,84%{opacity:1;translate:0 0}
  90%,100%{opacity:0;translate:0 -10px}
}
@media(prefers-reduced-motion:reduce){.hero-art .art-sun,.hero-art .art-box,.hero-art .art-van,.hero-art .art-night,.hero-art .art-moon,.hero-art .float-tag,.hero-art .art-step,.hero-art .art-step i{animation:none}}
`;

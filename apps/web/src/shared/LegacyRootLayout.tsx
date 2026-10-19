import fs from "node:fs";
import path from "node:path";
import PwaInstall from "./PwaInstall";

// Hide only pages that still require the legacy scripts to finish booting.
const BOOT_CSS = "html:not(.legacy-ready) body:has([data-legacy-boot]){opacity:0}";

/**
 * Root layout for a ported page. The page's CSS is inlined verbatim, like the <style>
 * blocks in the original .html files. It deliberately skips the CSS bundler, whose
 * minifier rewrites declarations (e.g. `background:transparent` -> `background:0 0`).
 */
export default function LegacyRootLayout({ app, children }: { app: string; children: React.ReactNode }) {
  const css = fs.readFileSync(path.join(process.cwd(), "src/features", app, "styles.css"), "utf8");
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/deliveryfast.webmanifest" />
        <style dangerouslySetInnerHTML={{ __html: BOOT_CSS }} />
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <noscript>
          <style>{"body{opacity:1!important}"}</style>
        </noscript>
      </head>
      <body data-app={app}>
        {children}
        <PwaInstall />
      </body>
    </html>
  );
}

// Copies browser builds of third-party libraries into public/vendor so the legacy page
// scripts (which have no bundler) can load them: <script src="/vendor/leaflet/leaflet.js">.
// Runs on npm install (postinstall). public/vendor is generated; don't edit it by hand.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const out = path.resolve(import.meta.dirname, "../public/vendor");
const pkgDir = name => path.dirname(require.resolve(`${name}/package.json`));
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};

fs.rmSync(out, { recursive: true, force: true });
const leaflet = path.join(pkgDir("leaflet"), "dist");
copy(path.join(leaflet, "leaflet.js"), path.join(out, "leaflet/leaflet.js"));
copy(path.join(leaflet, "leaflet.css"), path.join(out, "leaflet/leaflet.css"));
copy(path.join(leaflet, "images"), path.join(out, "leaflet/images"));
copy(path.join(pkgDir("@zxing/browser"), "umd/zxing-browser.min.js"), path.join(out, "zxing/zxing-browser.min.js"));
console.log("vendor files copied to public/vendor");

// Load order: the API client (restores the session and data), the original page scripts,
// then bridge.js, which connects their actions to the API. See public/legacy/README.md.
export const scripts = [
  "/legacy/shared/api.js",
  "/legacy/website/01.js",
  "/legacy/website/02.js",
  "/legacy/shared/support.js",
  "/legacy/website/bridge.js"
];

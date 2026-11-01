import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
// Baked in when the bundle is built, so a tab can show exactly which build it
// is running (the browser target in web/ injects the same two constants).
const buildTime = new Date().toISOString();

// The tiled app UI. `npm run build` emits ui/dist, served by src/admin.ts at
// "/" (and imported as a module by the browser target in web/).
export default defineConfig({
  plugins: [solid()],
  base: "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version ?? "0.0.0"),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  server: {
    port: 5174,
    // Dev: proxy the admin API so the standalone app talks to the running bot.
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});

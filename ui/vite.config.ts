import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The tiled app UI. `npm run build` emits ui/dist, served by src/admin.ts at
// "/" (and imported as a module by the browser target in web/).
export default defineConfig({
  plugins: [solid()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  server: {
    port: 5174,
    // Dev: proxy the admin API so the standalone app talks to the running bot.
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});

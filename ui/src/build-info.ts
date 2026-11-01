/** The running build's version + timestamp, injected by Vite at build time
 *  (ui/vite.config.ts and web/vite.config.ts both define these constants). */
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD HH:mm`, so the stamp reads in the viewer's clock. */
function localStamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

const version = typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "dev";
const builtAt = (() => {
  if (typeof __BUILD_TIME__ !== "string") return null;
  const date = new Date(__BUILD_TIME__);
  return Number.isNaN(date.getTime()) ? null : date;
})();

export const buildInfo = {
  label: builtAt ? `v${version} · ${localStamp(builtAt)}` : `v${version}`,
  title: builtAt
    ? `grandpa-bob v${version}\nbuilt ${builtAt.toLocaleString()} (${builtAt.toISOString()})`
    : `grandpa-bob v${version} — dev build`,
};

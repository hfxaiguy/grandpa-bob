/** Vite serves imported images as URLs; the Solid UI is typechecked without
 *  `vite/client`, so declare the formats it imports here. */
declare module "*.webp" {
  const src: string;
  export default src;
}

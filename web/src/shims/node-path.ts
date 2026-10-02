/**
 * Vite alias target for `node:path`. Maps to the shared pure POSIX shim so
 * existing NodeNext modules that `import path from "node:path"` bundle and
 * run in the browser unchanged.
 */
import { posixPath } from "../../../src/platform/paths";

export default posixPath;
export const sep = posixPath.sep;
export const resolve = posixPath.resolve;
export const join = posixPath.join;
export const relative = posixPath.relative;
export const dirname = posixPath.dirname;
export const basename = posixPath.basename;
export const extname = posixPath.extname;
export const isAbsolute = posixPath.isAbsolute;
export const normalize = posixPath.normalize;

/**
 * Attachment tests run over the in-memory Platform, proving the shared
 * attachment code has no Node dependency (the browser uses OPFS instead).
 */
import assert from "node:assert/strict";
import { MAX_ATTACHMENT_BYTES, attachmentPrompt, saveAttachment } from "../src/attachments.js";
import { createMemoryPlatform } from "../src/platform/memory.js";

const platform = createMemoryPlatform({ root: "/workspace" });
const { fs, path } = platform;

const attachment = await saveAttachment(
  platform,
  "invoice March?.pdf",
  new TextEncoder().encode("pdf bytes"),
  "application/pdf",
);

assert.match(attachment.path, /^assets\/inbox\/.+-invoice_March_\.pdf$/);
assert.equal(attachment.filename, "invoice March?.pdf");
assert.equal(attachment.mimeType, "application/pdf");
assert.equal(attachment.size, 9);
assert.equal(await fs.readFile(path.join(platform.workspaceRoot, attachment.path)), "pdf bytes");
assert.deepEqual(
  (await fs.readdir(path.join(platform.workspaceRoot, "assets/inbox"), { withFileTypes: true })).map((e) => e.name),
  [path.basename(attachment.path)],
);
assert.equal(
  attachmentPrompt(attachment, "Please summarize this"),
  `Please summarize this\n\n[Attached file: ${attachment.path} (application/pdf, 9 bytes)]`,
);
assert.equal(
  attachmentPrompt(attachment),
  `[Attached file: ${attachment.path} (application/pdf, 9 bytes)]`,
);

await assert.rejects(
  () => saveAttachment(platform, "empty.txt", new Uint8Array(0)),
  /attachment is empty/,
);
await assert.rejects(
  () => saveAttachment(platform, "large.bin", new Uint8Array(MAX_ATTACHMENT_BYTES + 1)),
  /attachment too large/,
);

console.log("attachments-test: all assertions passed (over in-memory Platform)");

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_ATTACHMENT_BYTES, attachmentPrompt, saveAttachment } from "../src/attachments.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "grandpa-bob-attachments-"));

try {
  const attachment = await saveAttachment(
    workspace,
    "invoice March?.pdf",
    Buffer.from("pdf bytes"),
    "application/pdf",
  );

  assert.match(attachment.path, /^assets\/inbox\/[0-9a-f-]+-invoice_March_.pdf$/);
  assert.equal(attachment.filename, "invoice March?.pdf");
  assert.equal(attachment.mimeType, "application/pdf");
  assert.equal(attachment.size, 9);
  assert.equal(await readFile(path.join(workspace, attachment.path), "utf8"), "pdf bytes");
  assert.deepEqual(await readdir(path.join(workspace, "assets/inbox")), [path.basename(attachment.path)]);
  assert.equal(
    attachmentPrompt(attachment, "Please summarize this"),
    `Please summarize this\n\n[Attached file: ${attachment.path} (application/pdf, 9 bytes)]`,
  );
  assert.equal(
    attachmentPrompt(attachment),
    `[Attached file: ${attachment.path} (application/pdf, 9 bytes)]`,
  );

  await assert.rejects(
    () => saveAttachment(workspace, "empty.txt", Buffer.alloc(0)),
    /attachment is empty/,
  );
  await assert.rejects(
    () => saveAttachment(workspace, "large.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)),
    /attachment too large/,
  );

  console.log("attachments-test: all assertions passed");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

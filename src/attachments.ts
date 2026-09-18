import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface AttachmentMetadata {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function attachmentPrompt(attachment: AttachmentMetadata, text = ""): string {
  const prefix = `[Attached file: ${attachment.path} (${attachment.mimeType}, ${attachment.size} bytes)]`;
  return text ? `${text}\n\n${prefix}` : prefix;
}

function safeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 180) || "upload";
}

/** Store an uploaded file outside the chat/checkpoint payload. */
export async function saveAttachment(
  workspaceDir: string,
  filename: string,
  content: Buffer,
  mimeType = "application/octet-stream",
): Promise<AttachmentMetadata> {
  if (content.length === 0) throw new Error("attachment is empty");
  if (content.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("attachment too large (max 50 MB)");
  }

  const dir = path.join(workspaceDir, "assets", "inbox");
  await mkdir(dir, { recursive: true });
  const storedName = `${randomUUID()}-${safeFilename(filename)}`;
  const absolute = path.join(dir, storedName);
  const temporary = `${absolute}.part`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, absolute);

  return {
    path: path.relative(workspaceDir, absolute),
    filename: filename || storedName,
    mimeType: mimeType || "application/octet-stream",
    size: content.length,
  };
}

import type { Platform } from "./platform/types.js";

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

function safeFilename(path: Platform["path"], filename: string): string {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 180) || "upload";
}

/** Store an uploaded file outside the chat/checkpoint payload. */
export async function saveAttachment(
  platform: Platform,
  filename: string,
  content: Uint8Array,
  mimeType = "application/octet-stream",
): Promise<AttachmentMetadata> {
  if (content.length === 0) throw new Error("attachment is empty");
  if (content.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("attachment too large (max 50 MB)");
  }

  const { fs, path, crypto, workspaceRoot } = platform;
  const dir = path.join(workspaceRoot, "assets", "inbox");
  await fs.mkdir(dir, { recursive: true });
  const storedName = `${crypto.randomUUID()}-${safeFilename(path, filename)}`;
  const absolute = path.join(dir, storedName);
  const temporary = `${absolute}.part`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, absolute);

  return {
    path: path.relative(workspaceRoot, absolute),
    filename: filename || storedName,
    mimeType: mimeType || "application/octet-stream",
    size: content.length,
  };
}

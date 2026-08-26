const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB — safe multiple of 256 KB

export type UploadProgress = { sent: number; total: number };

/**
 * Uploads a file to a YouTube resumable session URL in chunks.
 * Chunked transfer keeps 5 GB uploads recoverable and avoids the
 * truncated-stream errors that cause "video parse failed" on YouTube.
 */
export async function uploadResumable(
  uploadUrl: string,
  file: File,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const total = file.size;
  let offset = 0;
  let attempts = 0;

  while (offset < total) {
    if (signal?.aborted) throw new Error("Upload cancelled.");
    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = file.slice(offset, end);

    let res: Response;
    try {
      res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
          "Content-Type": file.type || "video/mp4",
        },
        body: chunk,
        signal: signal ?? null,
      });
    } catch (e) {
      attempts += 1;
      if (attempts > 5) throw e instanceof Error ? e : new Error("Network error during upload.");
      const resumed = await queryOffset(uploadUrl, total);
      offset = resumed;
      await new Promise((r) => setTimeout(r, 1500 * attempts));
      continue;
    }

    if (res.status === 308) {
      const range = res.headers.get("Range");
      offset = range ? Number(range.split("-")[1]) + 1 : end;
      attempts = 0;
      onProgress({ sent: offset, total });
      continue;
    }

    if (res.ok) {
      onProgress({ sent: total, total });
      const json = (await res.json()) as { id?: string };
      if (!json.id) throw new Error("YouTube did not return a video id.");
      return json.id;
    }

    if (res.status >= 500) {
      attempts += 1;
      if (attempts > 5) throw new Error(`YouTube upload failed (${res.status}).`);
      offset = await queryOffset(uploadUrl, total);
      await new Promise((r) => setTimeout(r, 1500 * attempts));
      continue;
    }

    const text = await res.text().catch(() => "");
    throw new Error(`YouTube rejected the upload (${res.status}). ${text.slice(0, 200)}`);
  }

  throw new Error("Upload finished without a response from YouTube.");
}

async function queryOffset(uploadUrl: string, total: number) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Range": `bytes */${total}` },
  });
  if (res.status === 308) {
    const range = res.headers.get("Range");
    return range ? Number(range.split("-")[1]) + 1 : 0;
  }
  return 0;
}

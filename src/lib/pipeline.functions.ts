import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  analyzeStory,
  buildMetadata,
  finalizeUpload,
  makeThumbnail,
  planThumbnail,
  runResearch,
  signThumbnail,
  startResumableUpload,
  verifyPublish,
  purgeExpiredArtifacts,
} from "./pipeline.server";
import { buildAuthUrl, getChannelRow, redirectUriFor } from "./youtube.server";
import { loadJob, persistDraft, saveThumbnailPath, listJobs, removeChannel } from "./jobs.server";

export const getConnection = createServerFn({ method: "GET" }).handler(async () => {
  // Opportunistic cleanup: removes server-side artifacts older than one hour.
  purgeExpiredArtifacts(60).catch(() => undefined);
  const row = await getChannelRow();
  return row
    ? {
        connected: true as const,
        channelId: row.channel_id,
        channelTitle: row.channel_title,
        thumbnailUrl: row.thumbnail_url,
      }
    : { connected: false as const };
});

export const getAuthLink = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ origin: z.string() }).parse(data))
  .handler(async ({ data }) => ({
    url: buildAuthUrl(data.origin, crypto.randomUUID()),
    redirectUri: redirectUriFor(data.origin),
  }));

export const disconnectChannel = createServerFn({ method: "POST" }).handler(async () => {
  await removeChannel();
  return { ok: true };
});

export const generatePlan = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        storyText: z.string(),
        fileName: z.string().optional(),
        fileSize: z.number().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const brief = await analyzeStory(data.storyText);
    const research = await runResearch(brief);
    const meta = await buildMetadata(brief, research);
    const thumbnailPlan = await planThumbnail(brief, research, meta).catch(() => null);
    const job = await persistDraft({
      fileName: data.fileName ?? null,
      fileSize: data.fileSize ?? null,
      meta,
      brief,
      research,
    });
    return { job, brief, research, meta, thumbnailPlan };
  });

export const createThumbnail = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        jobId: z.string(),
        prompt: z.string(),
        plan: z
          .object({
            competitorInsights: z.array(z.string()).default([]),
            concept: z.string().default(""),
            headline: z.string().default(""),
            kicker: z.string().default(""),
            composition: z.string().default(""),
            palette: z.string().default(""),
            typography: z.string().default(""),
            prompt: z.string().default(""),
          })
          .nullish(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const path = await makeThumbnail(data.jobId, data.prompt, data.plan ?? null);
    await saveThumbnailPath(data.jobId, path, data.prompt);
    return { url: await signThumbnail(path) };
  });

export const getJob = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ jobId: z.string() }).parse(data))
  .handler(async ({ data }) => loadJob(data.jobId));

export const recentJobs = createServerFn({ method: "GET" }).handler(async () => listJobs());

export const beginUpload = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        jobId: z.string(),
        fileSize: z.number(),
        mimeType: z.string(),
        origin: z.string().optional(),
      })
      .parse(data),
  )

  .handler(async ({ data }) => startResumableUpload(data));

export const completeUpload = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ jobId: z.string(), videoId: z.string() }).parse(data),
  )
  .handler(async ({ data }) => finalizeUpload(data.jobId, data.videoId));

export const verifyVideo = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ jobId: z.string(), videoId: z.string() }).parse(data),
  )
  .handler(async ({ data }) => verifyPublish(data.jobId, data.videoId));

export const purgeNow = createServerFn({ method: "POST" }).handler(async () =>
  purgeExpiredArtifacts(60),
);

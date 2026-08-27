import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Clapperboard,
  FileText,
  Loader2,
  Radar,
  Sparkles,
  Upload,
  Youtube,
  Link2Off,
  CheckCircle2,
  ImageIcon,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  beginUpload,
  completeUpload,
  createThumbnail,
  disconnectChannel,
  generatePlan,
  getAuthLink,
  getConnection,
  verifyVideo,
} from "@/lib/pipeline.functions";
import { uploadResumable } from "@/lib/resumable-upload";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MangaRank — AI Manhwa Video SEO & YouTube Auto-Publisher" },
      {
        name: "description",
        content:
          "Upload a manga or manhwa video plus its story file. AI writes the title, paints the thumbnail, researches live YouTube keywords, and publishes to your channel.",
      },
      { property: "og:title", content: "MangaRank — AI Manhwa Video SEO & Auto-Publisher" },
      {
        property: "og:description",
        content:
          "Story-driven titles and thumbnails, live YouTube keyword research, and one-click publishing for manga and manhwa channels.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

type Connection = { connected: boolean; channelTitle?: string; thumbnailUrl?: string | null };

type Plan = Awaited<ReturnType<typeof generatePlan>>;
type Verification = Awaited<ReturnType<typeof verifyVideo>>;

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function Home() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [redirectUri, setRedirectUri] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [storyName, setStoryName] = useState("");
  const [storyText, setStoryText] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [publishedVideoId, setPublishedVideoId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshConnection = async () => {
    const c = await getConnection();
    setConnection(c);
  };

  useEffect(() => {
    refreshConnection().catch(() => setConnection({ connected: false }));
    setRedirectUri(`${window.location.origin}/api/public/oauth/youtube/callback`);
  }, []);

  const connect = async () => {
    try {
      setBusy("connect");
      const { url } = await getAuthLink({ data: { origin: window.location.origin } });
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start Google sign-in");
      setBusy(null);
    }
  };

  const disconnect = async () => {
    await disconnectChannel();
    await refreshConnection();
    toast.success("Channel disconnected");
  };

  const readStory = async (file: File) => {
    const text = await file.text();
    setStoryName(file.name);
    setStoryText(text);
  };

  const runResearchStep = async () => {
    if (!storyText.trim()) {
      toast.error("Add the story .txt file first");
      return;
    }
    if (!connection?.connected) {
      toast.error("Connect your YouTube channel first");
      return;
    }
    try {
      setBusy("plan");
      setPublishedUrl(null);
      setVerification(null);
      setPublishedVideoId(null);
      const result = await generatePlan({
        data: {
          storyText,
          fileName: videoFile?.name ?? storyName,
          fileSize: videoFile?.size ?? 0,
        },
      });
      setPlan(result);
      setThumbUrl(null);
      toast.success("Research complete — metadata ready to review");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Research failed");
    } finally {
      setBusy(null);
    }
  };

  const makeThumb = async () => {
    if (!plan) return;
    try {
      setBusy("thumb");
      const { url } = await createThumbnail({
        data: {
          jobId: plan.job.id,
          prompt: plan.thumbnailPlan?.prompt || plan.brief.thumbnailPrompt,
          plan: plan.thumbnailPlan ?? null,
        },
      });
      setThumbUrl(url);
      toast.success("Thumbnail generated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Thumbnail generation failed");
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!plan || !videoFile) {
      toast.error("Pick the video file first");
      return;
    }
    try {
      setBusy("upload");
      setProgress(0);
      const { uploadUrl } = await beginUpload({
        data: {
          jobId: plan.job.id,
          fileSize: videoFile.size,
          mimeType: videoFile.type || "video/mp4",
        },
      });
      abortRef.current = new AbortController();
      const videoId = await uploadResumable(
        uploadUrl,
        videoFile,
        ({ sent, total }) => setProgress(Math.round((sent / total) * 100)),
        abortRef.current.signal,
      );
      setBusy("finalize");
      const done = await completeUpload({ data: { jobId: plan.job.id, videoId } });
      setPublishedUrl(done.url);
      setPublishedVideoId(done.videoId);
      toast.success(done.thumbnailApplied ? "Published with custom thumbnail" : "Published");
      setBusy("verify");
      const v = await verifyVideo({ data: { jobId: plan.job.id, videoId: done.videoId } });
      setVerification(v);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  };

  const recheck = async () => {
    if (!plan || !publishedVideoId) return;
    try {
      setBusy("verify");
      const v = await verifyVideo({ data: { jobId: plan.job.id, videoId: publishedVideoId } });
      setVerification(v);
      toast[v.ok ? "success" : "message"](
        v.ok ? "Video verified live on YouTube" : v.problems[0] ?? "Still processing",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(null);
    }
  };

  const stats = useMemo(() => {
    if (!plan) return null;
    return [
      { label: "Competitors scanned", value: plan.research.competitors.length },
      { label: "Autocomplete terms", value: plan.research.suggestions.length },
      { label: "Tags written", value: plan.meta.tags.length },
      { label: "Keywords targeted", value: plan.meta.keywords.length },
    ];
  }, [plan]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-10 sm:px-6">
      <header className="mb-10">
        <Badge className="mb-4 bg-secondary text-secondary-foreground">
          Manga · Manhwa · YouTube automation
        </Badge>
        <h1 className="text-4xl leading-none sm:text-6xl">
          <span className="text-gradient">Story in. Ranked video out.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Drop a manga or manhwa video and its story file. The AI writes the title, paints the
          thumbnail, runs fresh YouTube keyword research for every single upload, and publishes
          straight to your channel.
        </p>
      </header>

      {/* Channel */}
      <section className="panel mb-6 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="grid size-12 place-items-center rounded-xl bg-primary/15 text-primary">
            <Youtube className="size-6" />
          </div>
          <div>
            <h2 className="text-xl">
              {connection?.connected ? connection.channelTitle : "Connect your channel"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {connection?.connected
                ? "Ready to publish. Tokens refresh automatically."
                : "Sign in with Google to grant upload access."}
            </p>
          </div>
        </div>
        {connection?.connected ? (
          <Button variant="outline" onClick={disconnect}>
            <Link2Off className="size-4" /> Disconnect
          </Button>
        ) : (
          <Button onClick={connect} disabled={busy === "connect"}>
            {busy === "connect" ? <Loader2 className="size-4 animate-spin" /> : <Youtube className="size-4" />}
            Connect with Google
          </Button>
        )}
      </section>

      {/* Step 1 — files */}
      <section className="panel mb-6 p-6">
        <h2 className="mb-1 text-2xl">1 · Files</h2>
        <p className="mb-6 text-sm text-muted-foreground">
          The story text is used only for the title and thumbnail. Everything else comes from live
          search research.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="group flex cursor-pointer flex-col gap-2 rounded-xl border border-dashed border-border bg-secondary/40 p-6 transition-colors hover:border-primary">
            <div className="flex items-center gap-2 text-primary">
              <Clapperboard className="size-5" />
              <span className="font-bold">Video file (up to 5 GB)</span>
            </div>
            <span className="text-sm text-muted-foreground">
              {videoFile ? `${videoFile.name} · ${formatBytes(videoFile.size)}` : "MP4, MOV, MKV, WEBM"}
            </span>
            <Input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
            />
          </label>

          <label className="group flex cursor-pointer flex-col gap-2 rounded-xl border border-dashed border-border bg-secondary/40 p-6 transition-colors hover:border-accent">
            <div className="flex items-center gap-2 text-accent">
              <FileText className="size-5" />
              <span className="font-bold">Story .txt file</span>
            </div>
            <span className="text-sm text-muted-foreground">
              {storyName ? `${storyName} · ${storyText.length.toLocaleString()} characters` : "Full manga / manhwa story"}
            </span>
            <Input
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readStory(f);
              }}
            />
          </label>
        </div>

        <Textarea
          className="mt-4 min-h-28 bg-secondary/30"
          placeholder="…or paste the story text here"
          value={storyText}
          onChange={(e) => setStoryText(e.target.value)}
        />

        <Button className="mt-5" size="lg" onClick={runResearchStep} disabled={busy === "plan"}>
          {busy === "plan" ? <Loader2 className="size-4 animate-spin" /> : <Radar className="size-4" />}
          {busy === "plan" ? "Researching YouTube…" : "Analyse story & research keywords"}
        </Button>
      </section>

      {/* Step 2 — review */}
      {plan && (
        <section className="panel mb-6 p-6">
          <h2 className="mb-1 text-2xl">2 · Review</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            Fresh research ran for this upload. Edit nothing or tweak the thumbnail, then publish.
          </p>

          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats?.map((s) => (
              <div key={s.label} className="rounded-xl bg-secondary/50 p-4">
                <div className="font-display text-3xl text-accent">{s.value}</div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
            <div>
              <div className="mb-3 aspect-video overflow-hidden rounded-xl border border-border bg-secondary/50">
                {thumbUrl ? (
                  <img src={thumbUrl} alt="AI generated YouTube thumbnail" className="size-full object-cover" />
                ) : (
                  <div className="grid size-full place-items-center text-muted-foreground">
                    <ImageIcon className="size-8" />
                  </div>
                )}
              </div>
              <Button variant="outline" className="w-full" onClick={makeThumb} disabled={busy === "thumb"}>
                {busy === "thumb" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {thumbUrl ? "Regenerate thumbnail" : "Generate thumbnail"}
              </Button>

              {plan.thumbnailPlan && (
                <div className="mt-4 space-y-2 rounded-xl bg-secondary/40 p-4 text-sm">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Thumbnail plan from competitor analysis
                  </div>
                  <p className="text-foreground">{plan.thumbnailPlan.concept}</p>
                  <p className="text-muted-foreground">
                    Overlay text: <span className="text-accent">{plan.thumbnailPlan.headline}</span>
                    {plan.thumbnailPlan.kicker ? ` · ${plan.thumbnailPlan.kicker}` : ""}
                  </p>
                  <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {plan.thumbnailPlan.competitorInsights.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Title</div>
                <p className="text-lg font-bold">{plan.meta.title}</p>
              </div>
              <Separator />
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Description</div>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-sans text-sm text-muted-foreground">
                  {plan.meta.description}
                </pre>
              </div>
              <Separator />
              <div>
                <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Tags</div>
                <div className="flex flex-wrap gap-1.5">
                  {plan.meta.tags.map((t) => (
                    <Badge key={t} variant="secondary">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Hashtags</div>
                <div className="flex flex-wrap gap-1.5">
                  {plan.meta.hashtags.map((t) => (
                    <Badge key={t} className="bg-accent/20 text-accent">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
              {plan.meta.strategyNotes.length > 0 && (
                <div>
                  <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                    Ranking strategy
                  </div>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {plan.meta.strategyNotes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Step 3 — publish */}
      {plan && (
        <section className="panel p-6">
          <h2 className="mb-1 text-2xl">3 · Publish</h2>
          <p className="mb-6 text-sm text-muted-foreground">
            Chunked resumable upload streams the file straight to YouTube, so large files finish
            intact and never fail processing.
          </p>

          {busy === "upload" || progress > 0 ? (
            <div className="mb-4">
              <Progress value={progress} />
              <div className="mt-2 text-sm text-muted-foreground">{progress}% uploaded</div>
            </div>
          ) : null}

          {publishedUrl ? (
            <div className="space-y-4">
              <a
                href={publishedUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-accent underline"
              >
                <CheckCircle2 className="size-4" /> Live on YouTube — open video
              </a>

              <div
                className={`rounded-xl border p-4 ${
                  verification?.ok
                    ? "border-accent/50 bg-accent/10"
                    : "border-destructive/40 bg-destructive/10"
                }`}
              >
                <div className="mb-2 flex items-center gap-2 font-bold">
                  {verification?.ok ? (
                    <CheckCircle2 className="size-4 text-accent" />
                  ) : (
                    <AlertTriangle className="size-4 text-destructive" />
                  )}
                  {verification
                    ? verification.ok
                      ? "Verified live and fully processed on YouTube"
                      : "Not fully confirmed yet"
                    : "Checking publication…"}
                </div>
                {verification && (
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    <li>Upload status: {verification.uploadStatus ?? "—"}</li>
                    <li>Processing: {verification.processingStatus ?? "—"}</li>
                    <li>Privacy: {verification.privacyStatus ?? "—"}</li>
                    <li>Custom thumbnail: {verification.thumbnailApplied ? "applied" : "not applied"}</li>
                    {verification.problems.map((p: string) => (
                      <li key={p} className="text-destructive">{p}</li>
                    ))}
                  </ul>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={recheck}
                  disabled={busy === "verify"}
                >
                  {busy === "verify" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  Re-check
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Server copies of the generated thumbnail and research data are deleted
                automatically one hour after publishing. The YouTube video is never touched.
              </p>
            </div>
          ) : (
            <Button size="lg" onClick={publish} disabled={!!busy || !videoFile}>
              {busy === "upload" || busy === "finalize" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              {busy === "finalize" ? "Applying thumbnail…" : "Upload & publish to YouTube"}
            </Button>
          )}
        </section>
      )}

      <footer className="mt-10 rounded-xl border border-border/60 bg-secondary/30 p-4 text-xs text-muted-foreground">
        <span className="font-bold text-foreground">Authorised redirect URI:</span>{" "}
        <code className="break-all">{redirectUri}</code> — add this to your Google Cloud OAuth
        client.
      </footer>
    </main>
  );
}

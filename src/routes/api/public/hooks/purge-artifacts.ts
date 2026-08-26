import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

export const Route = createFileRoute("/api/public/hooks/purge-artifacts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await authenticateCronRequest(request);
        if (unauthorized) return unauthorized;

        const { purgeExpiredArtifacts } = await import("@/lib/pipeline.server");
        try {
          const result = await purgeExpiredArtifacts(60);
          return Response.json({ ok: true, ...result });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : "purge failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { exchangeCode, ytFetch } from "@/lib/youtube.server";

function page(title: string, body: string) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0b14;color:#f3eefe;display:grid;place-items:center;height:100vh;margin:0;text-align:center}a{color:#ff5d8f}</style>
</head><body><div><h1>${title}</h1><p>${body}</p><p><a href="/">Back to the app</a></p></div>
<script>setTimeout(function(){location.href='/'},2500)</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export const Route = createFileRoute("/api/public/oauth/youtube/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const error = url.searchParams.get("error");
        if (error) return page("Connection cancelled", error);

        const code = url.searchParams.get("code");
        if (!code) return page("Missing code", "Google did not return an authorization code.");

        try {
          const tokens = await exchangeCode(code, url.origin);
          if (!tokens.refresh_token) {
            return page(
              "Missing refresh token",
              "Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.",
            );
          }

          const me = (await ytFetch(
            "channels?part=snippet&mine=true",
            tokens.access_token,
          )) as {
            items?: {
              id?: string;
              snippet?: { title?: string; thumbnails?: { default?: { url?: string } } };
            }[];
          };
          const channel = me.items?.[0];
          if (!channel?.id) {
            return page("No channel found", "This Google account has no YouTube channel.");
          }

          await supabaseAdmin.from("youtube_channels").upsert(
            {
              channel_id: channel.id,
              channel_title: channel.snippet?.title ?? "YouTube channel",
              thumbnail_url: channel.snippet?.thumbnails?.default?.url ?? null,
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
              token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "channel_id" },
          );

          return page("Channel connected", `${channel.snippet?.title ?? "Your channel"} is ready.`);
        } catch (e) {
          return page("Connection failed", e instanceof Error ? e.message : "Unknown error");
        }
      },
    },
  },
});

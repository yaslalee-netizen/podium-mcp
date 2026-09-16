import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { podium, type Env } from "./podium";

export class PodiumMCP extends McpAgent<Env> {
  server = new McpServer({ name: "podium-adore", version: "1.0.0" });

  async init() {
    // Each "tool" is one thing Claude is allowed to ask Podium for.

    // RUN THIS ONE FIRST. Everything else needs a locationUid, which is a
    // long UUID, not the word "Auburn". This is how you find them.
    this.server.tool(
      "list_locations",
      "List Adore's Podium locations with their uid and name. Run this first — the other tools need the uid.",
      { limit: z.number().min(1).max(100).default(50) },
      async ({ limit }) => {
        const data = await podium(this.env, `locations?limit=${limit}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    );

    this.server.tool(
      "list_conversations",
      "List recent Podium conversations for one location, newest first.",
      {
        locationUid: z.string().describe("Location UUID from list_locations — not the location's name"),
        since: z.string().describe("ISO 8601 time, e.g. 2026-09-15T00:00:00Z. Returns conversations active at or after this."),
        limit: z.number().min(1).max(100).default(50),
        order: z.enum(["asc", "desc"]).default("desc"),
      },
      async ({ locationUid, since, limit, order }) => {
        const data = await podium(this.env,
          `conversations?locationUid=${locationUid}&since=${encodeURIComponent(since)}&limit=${limit}&order=${order}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    );

    this.server.tool(
      "get_conversation_messages",
      "Read the messages in one conversation.",
      {
        conversationUid: z.string().describe("Conversation UUID from list_conversations"),
        since: z.string().optional(),
        order: z.enum(["asc", "desc"]).default("asc"),
      },
      async ({ conversationUid, since, order }) => {
        let path = `conversations/${conversationUid}/messages?order=${order}`;
        if (since) path += `&since=${encodeURIComponent(since)}`;
        const data = await podium(this.env, path);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    );

    this.server.tool(
      "list_reviews",
      "List reviews, newest first. NOTE: Podium has no location filter on reviews — this covers the whole account.",
      {
        since: z.string().optional().describe("ISO date, e.g. 2026-09-01. Optional."),
        limit: z.number().min(1).max(100).default(50),
      },
      async ({ since, limit }) => {
        let path = `reviews?limit=${limit}`;
        // Podium documents createdAt as an "object" and shows this bracket form
        // in one example. If this errors, drop the `since` argument — limit alone works.
        if (since) path += `&createdAt[gte]=${encodeURIComponent(since)}`;
        const data = await podium(this.env, path);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Anything not using the secret address gets a blank "not found",
    // so a stranger can't even tell there's a server here.
    if (!url.pathname.startsWith(`/${env.SECRET_PATH}`)) {
      return new Response("Not found", { status: 404 });
    }
    const rest = url.pathname.slice(`/${env.SECRET_PATH}`.length);

    if (rest === "/mcp") {
      return PodiumMCP.serve(`/${env.SECRET_PATH}/mcp`).fetch(request, env, ctx);
    }
    if (rest === "/sse" || rest === "/sse/message") {
      return PodiumMCP.serveSSE(`/${env.SECRET_PATH}/sse`).fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};

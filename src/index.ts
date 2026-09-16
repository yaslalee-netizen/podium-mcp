import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { podium, type Env } from "./podium";

export class PodiumMCP extends McpAgent<Env> {
  server = new McpServer({ name: "podium-adore", version: "1.0.0" });

  async init() {
    // Each "tool" is one thing Claude is allowed to ask Podium for.
    this.server.tool(
      "list_conversations",
      "List recent Podium conversations for a location, newest first.",
      {
        locationId: z.string().describe("Auburn or Lansvale"),
        since: z.string().describe("Only conversations after this date/time"),
        limit: z.number().max(100).default(50),
      },
      async ({ locationId, since, limit }) => {
        const data = await podium(this.env,
          `conversations?locationId=${locationId}&since=${encodeURIComponent(since)}&limit=${limit}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    );

    this.server.tool(
      "get_conversation",
      "Read the full message history of one conversation.",
      { conversationId: z.string() },
      async ({ conversationId }) => {
        const data = await podium(this.env, `conversations/${conversationId}/messages`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
    );

    this.server.tool(
      "list_reviews",
      "List reviews for a location.",
      { locationId: z.string(), since: z.string() },
      async ({ locationId, since }) => {
        const data = await podium(this.env,
          `reviews?locationId=${locationId}&since=${encodeURIComponent(since)}`);
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

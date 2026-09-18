import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { podium, podiumRequest, type Env } from "./podium";
import { consume, previewText, stage } from "./confirm";

// Small helper so every tool returns text the same way.
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

// Podium wraps list responses as { data: [...], metadata: {...} } and single
// objects sometimes as { data: {...} }. This unwraps either shape.
const unwrap = (r: any) => (r && typeof r === "object" && "data" in r ? r.data : r);

// Phone numbers turn up as +61403568988, 0403 568 988, 403568988... Compare on
// the last 9 digits, which is the part that is actually the same every time.
const phoneKey = (s: string) => (s || "").replace(/\D/g, "").slice(-9);

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

    // ─────────────────────────────────────────────────────────────────────────
    // WRITE TOOLS — added 18 Sep 2026.
    //
    // Anything below that reaches a customer refuses to send on the first call.
    // It returns a preview and a one-time token; only a second call carrying
    // that token actually sends. See src/confirm.ts.
    // ─────────────────────────────────────────────────────────────────────────

    // 1. SEND A MESSAGE ───────────────────────────────────────────────────────
    // Podium's POST /v4/messages has no conversationUid field. It routes by
    // channel: send to the same channel type + identifier and the message lands
    // in that existing thread. So when given a conversationUid we look the
    // conversation up and reuse its channel exactly, which is the only reliable
    // way to reply into an existing conversation rather than starting a new one.
    this.server.tool(
      "send_message",
      "Send an SMS or email to a customer through Podium, either as a reply into an existing " +
      "conversation (pass conversationUid — preferred) or to a phone number/email address. " +
      "SAFETY: the first call NEVER sends. It returns the exact wording plus a confirmToken. " +
      "Show that wording to the human, get a clear yes, then call again with the same arguments " +
      "plus confirmToken. Never call twice in a row without a human approving in between.",
      {
        conversationUid: z.string().optional()
          .describe("Reply into this existing conversation. Preferred — its channel is reused so the reply threads correctly."),
        channelType: z.enum(["phone", "sms", "email", "facebook", "instagram", "whatsapp", "google", "webchat"]).optional()
          .describe("Only if you have no conversationUid. Use 'phone' for SMS."),
        channelIdentifier: z.string().optional()
          .describe("Only if you have no conversationUid. E164 phone (+61483939938) or an email address."),
        locationUid: z.string().optional()
          .describe("Required only when sending without a conversationUid. Lansvale is 01928ec4-3365-76f1-a5f2-0830a05701b0."),
        body: z.string().min(1).describe("The exact text the customer will receive."),
        contactName: z.string().optional().describe("Sets or updates the contact's name in Podium."),
        senderName: z.string().optional().describe("Shown under the sent message in the Podium app, e.g. 'Nas'."),
        subject: z.string().optional().describe("Email subject line. Ignored on SMS."),
        setOpenInbox: z.boolean().optional().describe("Put a brand new conversation in the open inbox instead of closed."),
        confirmToken: z.string().optional().describe("Only after a human has approved the previewed wording."),
      },
      async (args) => {
        const { conversationUid, body, contactName, senderName, subject, setOpenInbox, confirmToken } = args;
        let { channelType, channelIdentifier, locationUid } = args;
        let threadNote = "starting a NEW conversation";

        if (conversationUid) {
          const convo: any = unwrap(await podiumRequest(this.env, "GET", `conversations/${conversationUid}`));
          if (!convo?.channel?.identifier) {
            throw new Error(
              `Could not read a channel off conversation ${conversationUid}, so there is no safe way ` +
              `to tell where this message would go. Nothing was sent.`
            );
          }
          channelType = convo.channel.type;
          channelIdentifier = convo.channel.identifier;
          locationUid = locationUid || convo.locationUid;
          threadNote = `replying into existing conversation ${conversationUid}` +
            (convo.contactName ? ` with ${convo.contactName}` : "");
        }

        if (!channelType || !channelIdentifier) {
          throw new Error("Give either a conversationUid, or both channelType and channelIdentifier. Nothing was sent.");
        }
        if (!locationUid) {
          throw new Error("locationUid is required when sending without a conversationUid. Nothing was sent.");
        }

        const payload: Record<string, unknown> = {
          channel: { type: channelType, identifier: channelIdentifier },
          body,
          locationUid,
          ...(contactName ? { contactName } : {}),
          ...(senderName ? { senderName } : {}),
          ...(subject ? { subject } : {}),
          ...(setOpenInbox === undefined ? {} : { setOpenInbox }),
        };

        // Fingerprint covers destination AND wording, so an approved preview
        // cannot be swapped for different text at send time.
        const guard = { channelType, channelIdentifier, locationUid, body, subject: subject ?? null };

        if (!confirmToken) {
          const notes: string[] = [];
          if (channelType !== "email" && body.length > 320) {
            notes.push(`${body.length} characters — that is more than two SMS segments and will be billed as several.`);
          }
          if (!conversationUid) {
            notes.push("No conversationUid given, so this starts a new thread rather than replying to an existing one.");
          }
          return text(previewText("an outbound Podium message", {
            "To": `${channelIdentifier} (${channelType})`,
            "Thread": threadNote,
            "From location": locationUid,
            ...(subject ? { "Subject": subject } : {}),
            "Message": `\n---\n${body}\n---`,
          }, stage("send_message", guard), notes));
        }

        consume(confirmToken, "send_message", guard);
        const result = await podiumRequest(this.env, "POST", "messages", payload);
        return text({ sent: true, to: channelIdentifier, channel: channelType, result });
      }
    );

    // 2. REPLY TO A REVIEW ────────────────────────────────────────────────────
    this.server.tool(
      "reply_to_review",
      "Post a public reply to a review. SAFETY: the first call NEVER posts — it returns the review " +
      "being replied to, the draft reply, and a confirmToken. This reply is PUBLIC on Google. Get a " +
      "human to approve the exact wording, then call again with confirmToken.",
      {
        reviewUid: z.string().describe("Review UUID from list_reviews."),
        body: z.string().min(1).describe("The exact public reply."),
        confirmToken: z.string().optional(),
      },
      async ({ reviewUid, body, confirmToken }) => {
        const guard = { reviewUid, body };

        if (!confirmToken) {
          // Pull the review back so the human approves the reply against the
          // review it answers, rather than against a uid they cannot read.
          let context = "(could not load the review — check the uid)";
          try {
            const r: any = unwrap(await podiumRequest(this.env, "GET", `reviews/${reviewUid}`));
            context = `${r?.rating ?? "?"}★ from ${r?.authorName || r?.author || "unknown"} on ` +
              `${r?.site || r?.source || "unknown site"} (${r?.createdAt ?? "?"}):\n${r?.content ?? r?.body ?? "(no text)"}`;
          } catch { /* preview still useful without it */ }

          return text(previewText("a PUBLIC reply to a review", {
            "Review": `\n---\n${context}\n---`,
            "Your reply": `\n---\n${body}\n---`,
          }, stage("reply_to_review", guard), ["This reply is visible publicly on the review site."]));
        }

        consume(confirmToken, "reply_to_review", guard);
        const result = await podiumRequest(this.env, "POST", `reviews/${reviewUid}/responses`, { body });
        return text({ replied: true, reviewUid, result });
      }
    );

    // 3. SEND A REVIEW INVITE ─────────────────────────────────────────────────
    // Scope check the guide asked for: this needs write_reviews. NOT
    // "Write feedback" and NOT "Write campaigns" — those cover surveys and
    // campaign messages, which are different endpoints entirely.
    this.server.tool(
      "send_review_invite",
      "Text or email a customer a review invitation link. Needs the write_reviews scope. " +
      "SAFETY: the first call NEVER sends — it returns who would be invited plus a confirmToken. " +
      "One invite per customer: Podium disables a link that gets sent to several people.",
      {
        locationUid: z.string().describe("Lansvale is 01928ec4-3365-76f1-a5f2-0830a05701b0."),
        phoneNumber: z.string().optional().describe("E164, e.g. +61403568988. Give this or email."),
        email: z.string().optional().describe("Give this or phoneNumber."),
        confirmToken: z.string().optional(),
      },
      async ({ locationUid, phoneNumber, email, confirmToken }) => {
        if (!phoneNumber && !email) {
          throw new Error("Give a phoneNumber or an email. Nothing was sent.");
        }
        const guard = { locationUid, phoneNumber: phoneNumber ?? null, email: email ?? null };

        if (!confirmToken) {
          return text(previewText("a review invitation", {
            "To": phoneNumber || email || "",
            "From location": locationUid,
          }, stage("send_review_invite", guard), [
            "Podium composes the invite wording, not this tool.",
            "Send a customer only one invite — a link sent to several people can be disabled by Podium.",
          ]));
        }

        consume(confirmToken, "send_review_invite", guard);
        const result = await podiumRequest(this.env, "POST", "reviews/invites", {
          locationUid,
          ...(phoneNumber ? { phoneNumber } : {}),
          ...(email ? { email } : {}),
        });
        return text({ invited: true, to: phoneNumber || email, result });
      }
    );

    // 4. LOOK UP A CONTACT ────────────────────────────────────────────────────
    // Heads up: Podium's GET /v4/contacts takes only cursor, limit and
    // updated_at. There is no search-by-phone or search-by-email filter, so a
    // lookup by number is a paged scan done here. Bounded on purpose.
    this.server.tool(
      "find_contact",
      "Find a Podium contact. By uid it is a direct lookup. By phone/email/name it is a PAGED SCAN — " +
      "Podium's contacts endpoint has no search filter — so it reads up to maxPages x 100 contacts and " +
      "matches locally. If nothing is found, say it scanned N contacts rather than that the contact does not exist.",
      {
        uid: z.string().optional().describe("Direct lookup, cheapest by far."),
        phoneNumber: z.string().optional().describe("Any format — matched on the last 9 digits."),
        email: z.string().optional().describe("Case insensitive, exact."),
        name: z.string().optional().describe("Case insensitive, partial match."),
        maxPages: z.number().min(1).max(20).default(5).describe("100 contacts per page. Default 5 = 500 contacts."),
      },
      async ({ uid, phoneNumber, email, name, maxPages }) => {
        if (uid) return text(unwrap(await podiumRequest(this.env, "GET", `contacts/${uid}`)));
        if (!phoneNumber && !email && !name) {
          throw new Error("Give a uid, phoneNumber, email or name to search for.");
        }

        const wantPhone = phoneNumber ? phoneKey(phoneNumber) : null;
        const wantEmail = email ? email.trim().toLowerCase() : null;
        const wantName = name ? name.trim().toLowerCase() : null;

        const matches: unknown[] = [];
        let cursor: string | null = null;
        let scanned = 0;
        let pages = 0;

        while (pages < maxPages) {
          const path: string = cursor ? `contacts?cursor=${encodeURIComponent(cursor)}` : "contacts?limit=100";
          const page: any = await podiumRequest(this.env, "GET", path);
          const rows: any[] = Array.isArray(page?.data) ? page.data : [];
          scanned += rows.length;
          pages++;

          for (const c of rows) {
            const hitPhone = wantPhone && phoneKey(c?.phoneNumber || "") === wantPhone;
            const hitEmail = wantEmail && (c?.email || "").toLowerCase() === wantEmail;
            const hitName = wantName && (c?.name || "").toLowerCase().includes(wantName);
            if (hitPhone || hitEmail || hitName) matches.push(c);
          }

          cursor = page?.metadata?.nextCursor ?? null;
          if (!cursor || rows.length === 0) break;
        }

        return text({
          matches,
          matchCount: matches.length,
          contactsScanned: scanned,
          pagesRead: pages,
          scanExhausted: !cursor,
          note: cursor
            ? `Stopped at the maxPages limit with more contacts unread. "No match" here does NOT mean the contact is absent — raise maxPages to keep looking.`
            : `Reached the end of the contact list, so this result is complete.`,
        });
      }
    );

    // 5. CREATE OR UPDATE A CONTACT ───────────────────────────────────────────
    // POST /v4/contacts is an upsert: match on phone, email or conversation uid
    // and it updates rather than duplicating. One tool covers both jobs.
    this.server.tool(
      "upsert_contact",
      "Create a contact, or update an existing one. Podium matches on phone number or email and updates " +
      "in place if it finds one, so this is safe to call for a customer who may already exist. " +
      "This does not message anybody, so it needs no confirmation.",
      {
        name: z.string().describe("Required by Podium."),
        locations: z.array(z.string()).min(1)
          .describe("Location UUIDs. For Adore that is ['01928ec4-3365-76f1-a5f2-0830a05701b0']."),
        phoneNumber: z.string().optional().describe("Must be E164: +61403568988. Podium rejects 0403 568 988."),
        email: z.string().optional(),
        address: z.object({
          street: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          country: z.string().optional(),
        }).optional(),
        tags: z.array(z.string()).optional().describe("Tag UUIDs, not tag names."),
        confirmed: z.boolean().default(false)
          .describe("Set true to actually write. Left false it shows what would be written without writing."),
      },
      async ({ name, locations, phoneNumber, email, address, tags, confirmed }) => {
        if (phoneNumber && !/^\+[1-9]\d{1,15}$/.test(phoneNumber)) {
          throw new Error(
            `Podium requires E164 phone numbers like +61403568988. Got "${phoneNumber}". ` +
            `An Australian 04xx number becomes +614xx. Nothing was written.`
          );
        }
        const payload = {
          name,
          locations,
          ...(phoneNumber ? { phoneNumber } : {}),
          ...(email ? { email } : {}),
          ...(address ? { address } : {}),
          ...(tags ? { tags } : {}),
        };
        if (!confirmed) {
          return text({ wouldWrite: payload, nothingWritten: true, note: "Call again with confirmed: true to write this." });
        }
        const result = await podiumRequest(this.env, "POST", "contacts", payload);
        return text({ written: true, payload, result });
      }
    );

    // 6. APPOINTMENTS ─────────────────────────────────────────────────────────
    this.server.tool(
      "list_appointments",
      "List Podium appointments, oldest first by default. Use this to see what measures are booked.",
      {
        locationUid: z.string().optional().describe("Lansvale is 01928ec4-3365-76f1-a5f2-0830a05701b0."),
        since: z.string().optional().describe("ISO 8601. Filters on when the record last CHANGED, not the appointment time."),
        limit: z.number().min(1).max(100).default(50),
        order: z.enum(["asc", "desc"]).default("asc"),
      },
      async ({ locationUid, since, limit, order }) => {
        let path = `appointments?limit=${limit}&order=${order}`;
        if (locationUid) path += `&locationUid=${locationUid}`;
        if (since) path += `&since=${encodeURIComponent(since)}`;
        return text(await podiumRequest(this.env, "GET", path));
      }
    );

    this.server.tool(
      "get_appointment",
      "Read one appointment by its uid.",
      { uid: z.string() },
      async ({ uid }) => text(await podiumRequest(this.env, "GET", `appointments/${uid}`))
    );

    this.server.tool(
      "create_appointment",
      "Book an appointment in Podium — a flooring measure, for instance. SAFETY: the first call NEVER " +
      "books. Podium accounts commonly have reminder automations that text the customer when an " +
      "appointment is created, so this is treated as customer-facing: preview first, then confirm.",
      {
        contactName: z.string().describe("Customer's name."),
        contactPhoneNumber: z.string().describe("E164, e.g. +61403568988."),
        datetime: z.string().describe("ISO 8601 with timezone, e.g. 2026-09-24T10:00:00+10:00 for 10am Sydney."),
        locationUid: z.string().describe("Lansvale is 01928ec4-3365-76f1-a5f2-0830a05701b0."),
        durationMin: z.number().optional().describe("Minutes."),
        note: z.string().max(500).optional().describe("Max 500 characters. Put the address and job detail here."),
        status: z.enum(["unconfirmed", "confirmed", "cancelled", "completed", "no_show"]).optional(),
        type: z.enum(["in_person", "virtual"]).optional(),
        assignedUserUid: z.string().optional().describe("Podium user to assign it to, e.g. Nas."),
        confirmToken: z.string().optional(),
      },
      async (args) => {
        const { confirmToken, ...appt } = args;
        if (!/^\+[1-9]\d{1,15}$/.test(appt.contactPhoneNumber)) {
          throw new Error(
            `Podium requires E164 phone numbers like +61403568988. Got "${appt.contactPhoneNumber}". Nothing was booked.`
          );
        }
        const guard = {
          contactName: appt.contactName,
          contactPhoneNumber: appt.contactPhoneNumber,
          datetime: appt.datetime,
          locationUid: appt.locationUid,
          note: appt.note ?? null,
        };

        if (!confirmToken) {
          return text(previewText("a new Podium appointment", {
            "Customer": `${appt.contactName} (${appt.contactPhoneNumber})`,
            "When": appt.datetime + (appt.durationMin ? ` for ${appt.durationMin} min` : ""),
            "Location": appt.locationUid,
            "Type": appt.type ?? "in_person (default)",
            "Status": appt.status ?? "unconfirmed (default)",
            ...(appt.note ? { "Note": appt.note } : {}),
          }, stage("create_appointment", guard), [
            "Check the datetime offset is +10:00 (AEST) — Sydney moves to +11:00 on 4 Oct 2026.",
            "If the Podium account has an appointment reminder automation, creating this will text the customer.",
          ]));
        }

        consume(confirmToken, "create_appointment", guard);
        const result = await podiumRequest(this.env, "POST", "appointments", appt);
        return text({ booked: true, appointment: appt, result });
      }
    );

    // 7. LEAD RESPONSE TIMES ──────────────────────────────────────────────────
    // Podium's v4 API has no reporting endpoint — the "Read reporting" scope
    // exists in the developer portal but nothing in the v4 reference uses it.
    // So this computes response times from the message stream instead, which
    // is what "measure lead response times properly" actually needs.
    //
    // The important bit: Podium's own auto-reply goes out with senderUid null.
    // Counting that as a reply would make every lead look answered in seconds.
    // So this reports two clocks — time to ANY reply, and time to a reply from
    // a real person — and the second one is the honest number.
    this.server.tool(
      "lead_response_times",
      "Measure how fast Adore replies to inbound Podium enquiries. Reads conversations for a location and " +
      "works out, per conversation, how long the first inbound message waited for a reply. Reports the " +
      "automated auto-reply separately from a reply typed by a person, because the auto-reply otherwise " +
      "makes response times look far better than they are. Also lists conversations still unanswered.",
      {
        locationUid: z.string().describe("Lansvale is 01928ec4-3365-76f1-a5f2-0830a05701b0."),
        since: z.string().describe("ISO 8601, e.g. 2026-09-01T00:00:00Z."),
        maxConversations: z.number().min(1).max(40).default(20)
          .describe("Each conversation costs one extra API call, so this is capped at 40."),
      },
      async ({ locationUid, since, maxConversations }) => {
        const list: any = await podiumRequest(this.env, "GET",
          `conversations?locationUid=${locationUid}&since=${encodeURIComponent(since)}&limit=${maxConversations}&order=desc`);
        const conversations: any[] = Array.isArray(list?.data) ? list.data : [];

        const rows: any[] = [];
        for (const c of conversations) {
          const msgs: any = await podiumRequest(this.env, "GET",
            `conversations/${c.uid}/messages?order=asc&since=${encodeURIComponent(since)}`);
          const items: any[] = Array.isArray(msgs?.data) ? msgs.data : [];

          // Direction lives on items[].sourceType. senderUid null on an
          // outbound message means Podium sent it, not a person.
          const flat = items.map((m) => ({
            at: m.createdAt,
            inbound: (m.items?.[0]?.sourceType ?? (m.senderUid ? "outbound" : "inbound")) === "inbound",
            automated: !m.senderUid,
            body: m.body,
          })).filter((m) => m.at);

          const firstIn = flat.find((m) => m.inbound);
          if (!firstIn) continue; // nothing inbound in the window — not a lead

          const after = (m: any) => new Date(m.at).getTime() > new Date(firstIn.at).getTime();
          const firstAnyOut = flat.find((m) => !m.inbound && after(m));
          const firstHumanOut = flat.find((m) => !m.inbound && !m.automated && after(m));
          const mins = (m: any) =>
            m ? Math.round((new Date(m.at).getTime() - new Date(firstIn.at).getTime()) / 6000) / 10 : null;

          const last = flat[flat.length - 1];
          rows.push({
            conversationUid: c.uid,
            contact: c.contactName || c.channel?.identifier || "unknown",
            channel: c.channel?.type,
            firstInboundAt: firstIn.at,
            firstInboundText: (firstIn.body || "").slice(0, 140),
            minutesToAnyReply: mins(firstAnyOut),
            minutesToHumanReply: mins(firstHumanOut),
            firstReplyWasAutomated: !!firstAnyOut?.automated,
            stillAwaitingReply: !firstHumanOut,
            lastMessageInbound: !!last?.inbound,
          });
        }

        const human = rows.map((r) => r.minutesToHumanReply).filter((v): v is number => v !== null).sort((a, b) => a - b);
        const pct = (n: number) => (human.length ? Math.round((human.filter((v) => v <= n).length / human.length) * 100) : null);
        const median = human.length ? human[Math.floor((human.length - 1) / 2)] : null;

        return text({
          window: { locationUid, since, conversationsRead: conversations.length },
          summary: {
            leadsWithAnInboundMessage: rows.length,
            answeredByAPerson: human.length,
            neverAnsweredByAPerson: rows.filter((r) => r.stillAwaitingReply).length,
            medianMinutesToHumanReply: median,
            slowestMinutesToHumanReply: human.length ? human[human.length - 1] : null,
            percentAnsweredWithin5Min: pct(5),
            percentAnsweredWithin15Min: pct(15),
            percentAnsweredWithin60Min: pct(60),
          },
          caveat:
            "Minutes are wall-clock and take no account of trading hours (10am-6pm, Thursdays to 7pm), " +
            "so an enquiry that arrives overnight shows a long wait even when it was answered first thing.",
          conversations: rows,
        });
      }
    );

    // 8. PUSH A LEAD INTO PODIUM ──────────────────────────────────────────────
    // The "Write email leads" scope exists in the developer portal but the v4
    // reference publishes no email-lead endpoint. The supported way to push an
    // outside lead (a Shopify contact-form enquiry, say) into Podium is a data
    // feed event. It needs a data feed to have been created in Podium first —
    // that is a one-off setup step in the Podium app, and it hands you the uid.
    this.server.tool(
      "create_data_feed_event",
      "Push an outside lead or event into Podium through a configured data feed — this is how a website " +
      "contact-form enquiry gets into Podium. Requires a data feed to exist in Podium already; its uid " +
      "comes from the Podium app. The event's fields must match that feed's configuration.",
      {
        dataFeedUid: z.string().describe("UUID of the data feed, from the Podium app. There is no API to list feeds."),
        event: z.record(z.string(), z.any()).describe("One event object shaped to match the data feed's configuration."),
        confirmed: z.boolean().default(false).describe("Set true to actually send. False shows what would be sent."),
      },
      async ({ dataFeedUid, event, confirmed }) => {
        if (!confirmed) {
          return text({ wouldSend: event, toDataFeed: dataFeedUid, nothingSent: true,
            note: "Call again with confirmed: true to send. A data feed event can trigger Podium automations that message customers." });
        }
        const result = await podiumRequest(this.env, "POST", `dataFeeds/${dataFeedUid}/events`, event);
        return text({ sent: true, dataFeedUid, event, result });
      }
    );

    // 9. UPDATE A LOCATION ────────────────────────────────────────────────────
    // Added 18 Sep 2026 for a specific job: Podium's own automations merge in a
    // "Location Name" field, which reads displayName. Adore's displayName was
    // "Adore Rugs & Flooring Lansvale", so every templated message named a
    // showroom that closes in Dec 2026 — including messages to Auburn
    // customers, since the Podium number is published as Auburn's. Podium's UI
    // has no field for displayName, so it is changed here.
    this.server.tool(
      "update_location",
      "Change a Podium location's name, display name or phone number. displayName is what Podium's " +
      "automation templates merge in as 'Location Name', so it shows up in messages to customers. " +
      "Shows the before and after and changes nothing until confirmed: true.",
      {
        uid: z.string().describe("Location UUID. Lansvale is 01928ec4-3365-76f1-a5f2-0830a05701b0."),
        displayName: z.string().optional().describe("What templates merge in as 'Location Name'."),
        name: z.string().optional(),
        phoneNumber: z.string().optional().describe("E164, e.g. +61285260174."),
        confirmed: z.boolean().default(false).describe("Set true to actually write."),
      },
      async ({ uid, displayName, name, phoneNumber, confirmed }) => {
        if (phoneNumber && !/^\+[1-9]\d{1,15}$/.test(phoneNumber)) {
          throw new Error(`Podium requires E164 phone numbers like +61285260174. Got "${phoneNumber}". Nothing was changed.`);
        }
        const patch = {
          ...(displayName ? { displayName } : {}),
          ...(name ? { name } : {}),
          ...(phoneNumber ? { phoneNumber } : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw new Error("Give at least one of displayName, name or phoneNumber. Nothing was changed.");
        }
        const before: any = unwrap(await podiumRequest(this.env, "GET", `locations/${uid}`));
        if (!confirmed) {
          return text({
            current: { name: before?.name, displayName: before?.displayName, phoneNumber: before?.phoneNumber },
            wouldChangeTo: patch,
            nothingWritten: true,
            note: "displayName appears in customer-facing automated messages. Call again with confirmed: true to write.",
          });
        }
        const result = await podiumRequest(this.env, "PATCH", `locations/${uid}`, patch);
        const after: any = unwrap(await podiumRequest(this.env, "GET", `locations/${uid}`));
        return text({
          changed: true,
          before: { name: before?.name, displayName: before?.displayName, phoneNumber: before?.phoneNumber },
          after: { name: after?.name, displayName: after?.displayName, phoneNumber: after?.phoneNumber },
          result,
        });
      }
    );

    // 10. CALLS ──────────────────────────────────────────────────────────────
    // Added 18 Sep 2026. Until now the connector read messages only, so the
    // 6:30pm follow-up report carried the line "Calls not covered". Calls are
    // roughly two thirds of Adore's Podium volume (337 incoming in 30 days
    // against 87 conversations), so that was the bigger half of the inbox.
    //
    // What Podium's v4 API does and does not give you, checked against the
    // docs rather than assumed: you get status, direction, duration and
    // whether a voicemail exists. There is NO call recording, NO call
    // transcript and NO AI call summary on any v4 endpoint. Voicemail is the
    // one place spoken words are available, and only as a transcript.
    this.server.tool(
      "list_calls",
      "List Podium calls for a location. Returns status, direction, duration and whether a voicemail " +
      "was left. NOTE: on this list endpoint Podium always returns startedAt, endedAt, isPrivate and " +
      "conversationUid as null — use get_call for those. There are no call recordings, transcripts or " +
      "AI summaries anywhere in Podium's v4 API; voicemail transcripts are the only spoken content.",
      {
        locationUid: z.string().optional().describe("Lansvale is 01928ec4-3365-76f1-a5f2-0830a05701b0."),
        since: z.string().optional().describe("ISO 8601. Filters on updatedAt, not when the call happened."),
        limit: z.number().min(1).max(100).default(50),
        order: z.enum(["asc", "desc"]).default("desc"),
      },
      async ({ locationUid, since, limit, order }) => {
        let path = `calls?limit=${limit}&order=${order}`;
        if (locationUid) path += `&locationUid=${locationUid}`;
        if (since) path += `&since=${encodeURIComponent(since)}`;
        return text(await podiumRequest(this.env, "GET", path));
      }
    );

    this.server.tool(
      "get_call",
      "Read one call in full, including startedAt, endedAt and conversationUid, which the list endpoint " +
      "leaves null. Set includeVoicemail to also fetch the voicemail transcript if one was left.",
      {
        uid: z.string().describe("Call UUID from list_calls."),
        includeVoicemail: z.boolean().default(false),
      },
      async ({ uid, includeVoicemail }) => {
        const call = unwrap(await podiumRequest(this.env, "GET", `calls/${uid}`));
        if (!includeVoicemail) return text(call);
        let voicemail: unknown = null;
        try {
          voicemail = unwrap(await podiumRequest(this.env, "GET", `calls/${uid}/voicemail`));
        } catch {
          // Podium returns 404 when no voicemail was left. Not an error worth failing on.
          voicemail = { none: true };
        }
        return text({ call, voicemail });
      }
    );

    this.server.tool(
      "call_activity",
      "Summarise recent call activity for a location and pull the transcript of every voicemail left in " +
      "the window. Groups calls by their real Podium status rather than guessing which ones count as " +
      "missed, so you can see the actual status values before deciding. Use this to find callers who " +
      "never got through and hear what they wanted.",
      {
        locationUid: z.string().describe("Lansvale is 01928ec4-3365-76f1-a5f2-0830a05701b0."),
        since: z.string().describe("ISO 8601, e.g. 2026-09-15T00:00:00Z."),
        limit: z.number().min(1).max(100).default(100).describe("Calls to read."),
        maxVoicemails: z.number().min(0).max(25).default(10)
          .describe("Each voicemail costs one extra API call, so this is capped."),
      },
      async ({ locationUid, since, limit, maxVoicemails }) => {
        const list: any = await podiumRequest(this.env, "GET",
          `calls?locationUid=${locationUid}&since=${encodeURIComponent(since)}&limit=${limit}&order=desc`);
        const calls: any[] = Array.isArray(list?.data) ? list.data : [];

        const byStatus: Record<string, number> = {};
        const byDirection: Record<string, number> = {};
        for (const c of calls) {
          byStatus[c?.status ?? "unknown"] = (byStatus[c?.status ?? "unknown"] ?? 0) + 1;
          byDirection[c?.direction ?? "unknown"] = (byDirection[c?.direction ?? "unknown"] ?? 0) + 1;
        }

        // Voicemail is the only place a caller's own words are available.
        const withVoicemail = calls.filter((c) => c?.hasVoicemail).slice(0, maxVoicemails);
        const voicemails: any[] = [];
        for (const c of withVoicemail) {
          try {
            const vm: any = unwrap(await podiumRequest(this.env, "GET", `calls/${c.uid}/voicemail`));
            voicemails.push({
              callUid: c.uid,
              from: c.customerPhoneNumber,
              status: c.status,
              durationSeconds: vm?.durationSeconds,
              transcript: vm?.transcript ?? "(not transcribed yet)",
            });
          } catch (e) {
            voicemails.push({ callUid: c.uid, from: c.customerPhoneNumber, error: String(e).slice(0, 200) });
          }
        }

        // Inbound calls that connected to nobody are the follow-up list. No
        // status is hardcoded as "missed" here; the caller reads statusCounts
        // and decides, because Podium documents 21 status values.
        const inboundShort = calls
          .filter((c) => c?.direction === "inbound")
          .map((c) => ({
            uid: c.uid,
            from: c.customerPhoneNumber,
            status: c.status,
            durationSeconds: c.durationSeconds,
            hasVoicemail: !!c.hasVoicemail,
            handledByUserUid: c.userUid ?? null,
            updatedAt: c.updatedAt,
          }));

        return text({
          window: { locationUid, since, callsRead: calls.length, totalItems: list?.metadata?.totalItems ?? null },
          statusCounts: byStatus,
          directionCounts: byDirection,
          voicemailsFound: calls.filter((c) => c?.hasVoicemail).length,
          voicemailsRead: voicemails.length,
          voicemails,
          inboundCalls: inboundShort,
          limits:
            "Podium's v4 API has no call recording, no call transcript and no AI call summary. " +
            "Voicemail transcripts are the only spoken content available. Times are UTC; Sydney is +10 until 4 Oct 2026.",
        });
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

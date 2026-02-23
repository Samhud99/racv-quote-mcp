import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createSession,
  getSession,
  destroySession,
  getActiveSessions,
} from "./automation/session-manager.js";
import {
  findCarByRego,
  findCarManually,
  fillCarDetails,
  fillDriverDetails,
  extractQuoteResults,
} from "./automation/quote-flow.js";
import type { CarDetailsInput, DriverDetailsInput } from "./types.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

// ─── MCP Server ──────────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "racv-quote",
    version: "1.0.0",
  });

  // ── Tool: start_quote ────────────────────────────────────────────────────

  server.registerTool(
    "start_quote",
    {
      title: "Start Quote",
      description:
        "Step 1 of 4: Start a new RACV car insurance quote. IMPORTANT: Before calling this tool, ask the user for ALL details needed for the entire quote in one go: (1) rego + state OR year/make/model/bodyType, (2) overnight parking address, (3) under finance? (4) purpose: Private/Business/Private and Business, (5) business registered? (6) RACV member? (7) gender, (8) age, (9) age when they got their licence, (10) any accidents in last 5 years? Gather everything first, then call all 4 tools in sequence. Each tool takes 60-90 seconds (real browser automation). Do NOT build a UI — call these tools directly.",
      inputSchema: {
        rego: z
          .string()
          .optional()
          .describe("Vehicle registration number (e.g. ABC123). Provide either rego+state OR year+make+model+bodyType."),
        state: z
          .string()
          .optional()
          .describe("State the car is registered in (VIC, NSW, QLD, SA, WA, TAS, NT, ACT). Required if rego is provided."),
        year: z.string().optional().describe("Vehicle year (e.g. 2020). Use if rego is not available."),
        make: z.string().optional().describe("Vehicle make (e.g. Toyota). Use if rego is not available."),
        model: z.string().optional().describe("Vehicle model (e.g. Corolla). Use if rego is not available."),
        bodyType: z.string().optional().describe("Vehicle body type (e.g. SEDAN, HATCH, SUV). Use if rego is not available."),
      },
    },
    async ({ rego, state, make, model, year, bodyType }) => {
      let sessionId: string | undefined;
      try {
        const session = await createSession();
        sessionId = session.id;
        let carDescription: string;

        if (rego && state) {
          carDescription = await findCarByRego(session.page, rego, state);
        } else if (year && make && model && bodyType) {
          carDescription = await findCarManually(session.page, year, make, model, bodyType);
        } else {
          await destroySession(session.id);
          return {
            content: [
              {
                type: "text" as const,
                text: "Please provide either rego + state, or year + make + model + bodyType to find the car.",
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                sessionId: session.id,
                status: "car_found",
                car: carDescription,
                nextStep: "Call fill_car_details with the sessionId to continue.",
              }),
            },
          ],
        };
      } catch (err: any) {
        if (sessionId) await destroySession(sessionId).catch(() => {});
        const msg = err.message || "Unknown error";
        const isRegoNotFound = msg.includes("not found") || msg.includes("couldn't find");
        const guidance = isRegoNotFound
          ? "Ask the user to verify their rego and state, or try start_quote with year/make/model/bodyType instead."
          : "Call start_quote again to retry — the RACV website may have been slow to respond.";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to start quote: ${msg}. ${guidance}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── Tool: fill_car_details ───────────────────────────────────────────────

  server.registerTool(
    "fill_car_details",
    {
      title: "Fill Car Details",
      description:
        "Step 2 of 4: Fill car details for an active quote session. Call immediately after start_quote succeeds — you should already have all the details from asking the user upfront. Takes 60-90 seconds.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from start_quote"),
        address: z.string().describe("Overnight parking address (e.g. '1 Collins St Melbourne')"),
        underFinance: z.boolean().describe("Is the car currently under finance?"),
        purpose: z.string().describe("Main purpose of the car: 'Private', 'Business', or 'Private and Business'"),
        businessRegistered: z.boolean().describe("Is the car registered under a business name?"),
        coverStartDate: z.string().optional().describe("Cover start date in DD/MM/YYYY format"),
        email: z.string().optional().describe("Email address for the quote"),
      },
    },
    async ({ sessionId, address, underFinance, purpose, businessRegistered, coverStartDate, email }) => {
      try {
        const session = getSession(sessionId);
        if (!session) {
          return {
            content: [{ type: "text" as const, text: "Session not found or expired. Start a new quote." }],
            isError: true,
          };
        }

        const input: CarDetailsInput = {
          address,
          underFinance,
          purpose,
          businessRegistered,
          coverStartDate: coverStartDate || "",
          email,
        };

        await fillCarDetails(session.page, input);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                sessionId,
                status: "car_details_filled",
                nextStep: "Call fill_driver_details with the sessionId to continue.",
              }),
            },
          ],
        };
      } catch (err: any) {
        await destroySession(sessionId).catch(() => {});
        return {
          content: [{ type: "text" as const, text: `Failed to fill car details: ${err.message}. Session destroyed — call start_quote to begin a new quote.` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool: fill_driver_details ────────────────────────────────────────────

  server.registerTool(
    "fill_driver_details",
    {
      title: "Fill Driver Details",
      description:
        "Step 3 of 4: Fill driver details for an active quote session. Call immediately after fill_car_details succeeds — you should already have all the details from asking the user upfront. Takes 60-90 seconds.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from start_quote"),
        racvMember: z.boolean().describe("Is the driver an existing RACV member?"),
        gender: z.enum(["male", "female"]).describe("Driver's gender"),
        age: z.number().describe("Driver's age in years"),
        licenceAge: z.number().describe("Age when the driver got their licence"),
        accidentsLast5Years: z.boolean().describe("Has the driver had any accidents or incidents in the last 5 years?"),
      },
    },
    async ({ sessionId, racvMember, gender, age, licenceAge, accidentsLast5Years }) => {
      try {
        const session = getSession(sessionId);
        if (!session) {
          return {
            content: [{ type: "text" as const, text: "Session not found or expired. Start a new quote." }],
            isError: true,
          };
        }

        const input: DriverDetailsInput = {
          racvMember,
          gender,
          age,
          licenceAge,
          accidentsLast5Years,
        };

        await fillDriverDetails(session.page, input);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                sessionId,
                status: "driver_details_filled",
                nextStep: "Call get_quotes with the sessionId to retrieve the quote results.",
              }),
            },
          ],
        };
      } catch (err: any) {
        await destroySession(sessionId).catch(() => {});
        return {
          content: [{ type: "text" as const, text: `Failed to fill driver details: ${err.message}. Session destroyed — call start_quote to begin a new quote.` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool: get_quotes ─────────────────────────────────────────────────────

  server.registerTool(
    "get_quotes",
    {
      title: "Get Quotes",
      description:
        "Step 4 of 4: Extract insurance quote results. Call after fill_driver_details. Returns comprehensive and third party quotes with yearly/monthly pricing. This is the final step — the session is cleaned up automatically after quotes are retrieved.",
      inputSchema: {
        sessionId: z.string().describe("Session ID from start_quote"),
      },
    },
    async ({ sessionId }) => {
      try {
        const session = getSession(sessionId);
        if (!session) {
          return {
            content: [{ type: "text" as const, text: "Session not found or expired. Start a new quote." }],
            isError: true,
          };
        }

        const result = await extractQuoteResults(session.page);

        // Clean up the session after extracting quotes
        await destroySession(sessionId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        await destroySession(sessionId).catch(() => {});
        return {
          content: [{ type: "text" as const, text: `Failed to extract quotes: ${err.message}. Session destroyed — call start_quote to begin a new quote.` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─── Express + Transport ─────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", activeSessions: getActiveSessions() });
});

// MCP transport management
const transports = new Map<string, StreamableHTTPServerTransport>();

function isInitializeRequest(body: any): boolean {
  if (Array.isArray(body)) {
    return body.some((msg) => msg.method === "initialize");
  }
  return body?.method === "initialize";
}

app.all("/mcp", async (req, res) => {
  const method = req.method;

  if (method === "GET") {
    // SSE stream for server-initiated messages
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({ error: "Invalid or missing session ID" });
    }
    return;
  }

  if (method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({ error: "Invalid or missing session ID" });
    }
    return;
  }

  if (method === "POST") {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session
      const mcpServer = createMcpServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport);
          console.log(`MCP session created: ${sid} (total: ${transports.size})`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
          console.log(`MCP session closed: ${sid} (total: ${transports.size})`);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid session. Send an initialize request first." },
        id: null,
      });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RACV Quote MCP server running on http://0.0.0.0:${PORT}`);
  console.log(`  MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`  Health check: http://0.0.0.0:${PORT}/health`);
});

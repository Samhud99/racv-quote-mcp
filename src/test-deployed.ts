/**
 * Test the DEPLOYED MCP server end-to-end.
 * Calls all 4 tools in sequence against the Render URL.
 */
import { readFileSync } from "fs";

try {
  const envContent = readFileSync(".env", "utf-8");
  for (const line of envContent.split("\n")) {
    const [key, ...rest] = line.split("=");
    const value = rest.join("=");
    if (key && value) process.env[key.trim()] = value.trim();
  }
} catch {}

const BASE_URL = process.env.MCP_URL || "https://racv-quote-mcp.onrender.com/mcp";
const TEST_REGO = process.env.TEST_REGO || "ABC123";
const TEST_STATE = process.env.TEST_STATE || "VIC";

async function mcpRequest(
  method: string,
  params: any,
  id: number | null,
  sessionId?: string
): Promise<{ result: any; sessionId: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body: any = { jsonrpc: "2.0", method };
  if (id !== null) body.id = id;
  if (params) body.params = params;

  const resp = await fetch(BASE_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const newSessionId = resp.headers.get("mcp-session-id") || sessionId || "";

  const text = await resp.text();
  let result: any = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(line.substring(6));
        if (parsed.result) result = parsed.result;
        if (parsed.error) result = { error: parsed.error };
      } catch {}
    }
  }

  // If response is plain JSON (not SSE)
  if (!result) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.result) result = parsed.result;
      if (parsed.error) result = { error: parsed.error };
    } catch {}
  }

  return { result, sessionId: newSessionId };
}

async function run() {
  const totalStart = Date.now();
  console.log(`=== Deployed MCP E2E Test ===`);
  console.log(`URL: ${BASE_URL}`);
  console.log(`Rego: ${TEST_REGO}, State: ${TEST_STATE}\n`);

  // 1. Initialize
  console.log("1. Initialize...");
  const init = await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "1.0.0" },
  }, 1);
  const sid = init.sessionId;
  console.log(`   Server: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  console.log(`   Session: ${sid}\n`);

  if (!sid) { console.error("   No session ID!"); return; }

  // Send initialized notification
  await mcpRequest("notifications/initialized", undefined, null, sid);

  // 2. List tools
  console.log("2. List tools...");
  const tools = await mcpRequest("tools/list", {}, 2, sid);
  for (const t of tools.result?.tools || []) {
    console.log(`   - ${t.name}`);
  }
  console.log();

  // 3. start_quote
  console.log("3. start_quote...");
  let t0 = Date.now();
  const startRes = await mcpRequest("tools/call", {
    name: "start_quote",
    arguments: { rego: TEST_REGO, state: TEST_STATE },
  }, 3, sid);
  console.log(`   Took: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const startText = startRes.result?.content?.[0]?.text || "";
  if (startRes.result?.isError) {
    console.error(`   ERROR: ${startText}`);
    return;
  }
  const startData = JSON.parse(startText);
  console.log(`   Status: ${startData.status}`);
  console.log(`   Car: ${startData.car}`);
  const qSid = startData.sessionId;
  console.log(`   Quote session: ${qSid}\n`);

  // 4. fill_car_details
  console.log("4. fill_car_details...");
  t0 = Date.now();
  const carRes = await mcpRequest("tools/call", {
    name: "fill_car_details",
    arguments: {
      sessionId: qSid,
      address: "1 Collins St Melbourne",
      underFinance: false,
      purpose: "Private",
      businessRegistered: false,
    },
  }, 4, sid);
  console.log(`   Took: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const carText = carRes.result?.content?.[0]?.text || "";
  if (carRes.result?.isError) {
    console.error(`   ERROR: ${carText}`);
    return;
  }
  const carData = JSON.parse(carText);
  console.log(`   Status: ${carData.status}\n`);

  // 5. fill_driver_details
  console.log("5. fill_driver_details...");
  t0 = Date.now();
  const driverRes = await mcpRequest("tools/call", {
    name: "fill_driver_details",
    arguments: {
      sessionId: qSid,
      racvMember: false,
      gender: "female",
      age: 33,
      licenceAge: 18,
      accidentsLast5Years: false,
    },
  }, 5, sid);
  console.log(`   Took: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const driverText = driverRes.result?.content?.[0]?.text || "";
  if (driverRes.result?.isError) {
    console.error(`   ERROR: ${driverText}`);
    return;
  }
  const driverData = JSON.parse(driverText);
  console.log(`   Status: ${driverData.status}\n`);

  // 6. get_quotes
  console.log("6. get_quotes...");
  t0 = Date.now();
  const quoteRes = await mcpRequest("tools/call", {
    name: "get_quotes",
    arguments: { sessionId: qSid },
  }, 6, sid);
  console.log(`   Took: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const quoteText = quoteRes.result?.content?.[0]?.text || "";
  if (quoteRes.result?.isError) {
    console.error(`   ERROR: ${quoteText}`);
    return;
  }
  const quotes = JSON.parse(quoteText);

  console.log("=== QUOTE RESULTS ===\n");
  console.log(`Car: ${quotes.car?.description}`);
  console.log(`Driver: Age=${quotes.driver?.age}, Gender=${quotes.driver?.gender}\n`);

  console.log("Comprehensive:");
  for (const q of quotes.comprehensive || []) {
    console.log(`  ${q.name}: ${q.yearlyPrice}/yr | ${q.monthlyPrice}/mo`);
  }

  console.log("\nThird Party:");
  for (const q of quotes.thirdParty || []) {
    console.log(`  ${q.name}: ${q.yearlyPrice}/yr | ${q.monthlyPrice}/mo`);
  }

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n=== TOTAL TIME: ${totalTime}s ===`);
  console.log("=== DEPLOYED E2E TEST PASSED ===");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

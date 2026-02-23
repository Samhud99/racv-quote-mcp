/**
 * Test the MCP server by calling tools in sequence via HTTP.
 * Parses SSE responses from the Streamable HTTP transport.
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

const BASE_URL = "http://localhost:3000/mcp";
const TEST_REGO = process.env.TEST_REGO || "ABC123";
const TEST_STATE = process.env.TEST_STATE || "VIC";

async function mcpRequest(
  method: string,
  params: any,
  id: number,
  sessionId?: string
): Promise<{ result: any; sessionId: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body: any = { jsonrpc: "2.0", id, method };
  if (params) body.params = params;

  const resp = await fetch(BASE_URL, { method: "POST", headers, body: JSON.stringify(body) });

  // Get session ID from response headers
  const newSessionId = resp.headers.get("mcp-session-id") || sessionId || "";

  // Parse SSE response
  const text = await resp.text();
  const lines = text.split("\n");
  let result: any = null;

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(line.substring(6));
        if (parsed.result) result = parsed.result;
        if (parsed.error) result = { error: parsed.error };
      } catch {}
    }
  }

  return { result, sessionId: newSessionId };
}

async function run() {
  console.log("=== MCP Client Test ===\n");

  // 1. Initialize
  console.log("1. Initialize...");
  const init = await mcpRequest(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
    1
  );
  console.log(`   Server: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  console.log(`   Session: ${init.sessionId}\n`);

  const sid = init.sessionId;

  // Send initialized notification
  await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  // 2. List tools
  console.log("2. List tools...");
  const tools = await mcpRequest("tools/list", {}, 2, sid);
  for (const tool of tools.result?.tools || []) {
    console.log(`   - ${tool.name}: ${tool.description?.substring(0, 80)}...`);
  }
  console.log();

  // 3. Call start_quote
  console.log(`3. start_quote (rego=${TEST_REGO}, state=${TEST_STATE})...`);
  const startTime = Date.now();
  const startResult = await mcpRequest(
    "tools/call",
    { name: "start_quote", arguments: { rego: TEST_REGO, state: TEST_STATE } },
    3,
    sid
  );
  const startData = JSON.parse(startResult.result?.content?.[0]?.text || "{}");
  console.log(`   Status: ${startData.status}`);
  console.log(`   Car: ${startData.car}`);
  console.log(`   Session: ${startData.sessionId}`);
  console.log(`   Took: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

  if (startData.isError || !startData.sessionId) {
    console.error("   FAILED:", startResult.result);
    return;
  }

  const quoteSessionId = startData.sessionId;

  // 4. Call fill_car_details
  console.log("4. fill_car_details...");
  const carTime = Date.now();
  const carResult = await mcpRequest(
    "tools/call",
    {
      name: "fill_car_details",
      arguments: {
        sessionId: quoteSessionId,
        address: "1 Collins St Melbourne",
        underFinance: false,
        purpose: "Private",
        businessRegistered: false,
      },
    },
    4,
    sid
  );
  const carData = JSON.parse(carResult.result?.content?.[0]?.text || "{}");
  console.log(`   Status: ${carData.status}`);
  console.log(`   Took: ${((Date.now() - carTime) / 1000).toFixed(1)}s\n`);

  if (carResult.result?.isError) {
    console.error("   FAILED:", carResult.result);
    return;
  }

  // 5. Call fill_driver_details
  console.log("5. fill_driver_details...");
  const driverTime = Date.now();
  const driverResult = await mcpRequest(
    "tools/call",
    {
      name: "fill_driver_details",
      arguments: {
        sessionId: quoteSessionId,
        racvMember: false,
        gender: "female",
        age: 33,
        licenceAge: 18,
        accidentsLast5Years: false,
      },
    },
    5,
    sid
  );
  const driverData = JSON.parse(driverResult.result?.content?.[0]?.text || "{}");
  console.log(`   Status: ${driverData.status}`);
  console.log(`   Took: ${((Date.now() - driverTime) / 1000).toFixed(1)}s\n`);

  if (driverResult.result?.isError) {
    console.error("   FAILED:", driverResult.result);
    return;
  }

  // 6. Call get_quotes
  console.log("6. get_quotes...");
  const quoteTime = Date.now();
  const quoteResult = await mcpRequest(
    "tools/call",
    { name: "get_quotes", arguments: { sessionId: quoteSessionId } },
    6,
    sid
  );
  const quoteData = JSON.parse(quoteResult.result?.content?.[0]?.text || "{}");
  console.log(`   Took: ${((Date.now() - quoteTime) / 1000).toFixed(1)}s\n`);

  console.log("=== QUOTE RESULTS ===\n");
  console.log("Comprehensive:");
  for (const q of quoteData.comprehensive || []) {
    console.log(`  ${q.name}: ${q.yearlyPrice}/yr | ${q.monthlyPrice}/mo`);
  }
  console.log("\nThird Party:");
  for (const q of quoteData.thirdParty || []) {
    console.log(`  ${q.name}: ${q.yearlyPrice}/yr | ${q.monthlyPrice}/mo`);
  }

  console.log(`\n=== TOTAL TIME: ${((Date.now() - startTime) / 1000).toFixed(1)}s ===`);
  console.log("=== MCP CLIENT TEST PASSED ===");
}

run().catch(console.error);

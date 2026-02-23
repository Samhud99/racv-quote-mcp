/**
 * E2E test v18 — CLEAN final version. Proven approach:
 *   - networkidle for initial load
 *   - Playwright click({ force: true }) for buttons
 *   - keyboard.type() for LWC inputs
 *   - 20s wait for Salesforce Aura API processing
 */
import { mkdirSync, readFileSync } from "fs";

try {
  const envContent = readFileSync(".env", "utf-8");
  for (const line of envContent.split("\n")) {
    const [key, ...rest] = line.split("=");
    const value = rest.join("=");
    if (key && value) process.env[key.trim()] = value.trim();
  }
} catch {}

import { launchBrowser, humanDelay } from "./automation/browser.js";

const TEST_REGO = process.env.TEST_REGO || "ABC123";
const TEST_STATE = process.env.TEST_STATE || "VIC";

mkdirSync("test-screenshots", { recursive: true });

// Wait for page to contain text, with polling
const waitForText = async (page: any, text: string, timeoutMs = 30000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes(text)) return true;
    await humanDelay(2000, 2500);
  }
  return false;
};

const run = async () => {
  console.log("=== RACV E2E v18 (FINAL) ===\n");
  const { browser, page } = await launchBrowser();

  try {
    // ═══ STEP 1: Navigate + Find Car ═══
    console.log("STEP 1: Navigate + Find Car");
    await page.goto("https://my.racv.com.au/s/motor-insurance?p=CAR", {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    await page.locator('input[name="rego"]').fill(TEST_REGO);
    await page.locator('select[name="jurisdictionFieldValue"]').selectOption({ label: TEST_STATE });
    await humanDelay(800, 1200);
    await page.locator('button:has-text("Find Your car")').click({ force: true });
    await page.locator('input[name="addressSearch"]').waitFor({ timeout: 20000 });
    console.log("  Car found!\n");

    // ═══ STEP 2: Fill Car Details ═══
    console.log("STEP 2: Fill Car Details");
    // Address autocomplete (with retry)
    let addressFilled = false;
    for (let addrAttempt = 1; addrAttempt <= 2; addrAttempt++) {
      await page.locator('input[name="addressSearch"]').click();
      await humanDelay(300, 500);
      await page.locator('input[name="addressSearch"]').fill("");
      await page.locator('input[name="addressSearch"]').pressSequentially("1 Collins St Melbourne", { delay: 100 });
      await humanDelay(4000, 6000);
      const sugg = page.locator('li:has-text("Collins")').first();
      if ((await sugg.count()) > 0) {
        await sugg.click();
        await humanDelay(1500, 2000);
        const addrVal = await page.locator('input[name="addressSearch"]').inputValue();
        if (addrVal && addrVal.length > 10) {
          console.log(`  Address: ${addrVal}`);
          addressFilled = true;
          break;
        }
      }
      console.log(`  Address attempt ${addrAttempt} - no suggestion clicked, retrying...`);
      await page.locator('input[name="addressSearch"]').fill("");
      await humanDelay(1000, 2000);
    }
    if (!addressFilled) {
      console.log("  WARNING: Address may not be filled correctly");
    }

    // Under finance -> No
    await page.locator('label:has(input[name="UnderFinance"][value="No"])').click();
    await humanDelay(800, 1200);
    console.log("  Finance: No");

    // Purpose -> Private
    await page.locator('select[name="Purpose"]').selectOption("Private");
    await page.locator('select[name="Purpose"]').evaluate((el: any) => {
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });
    await humanDelay(800, 1200);
    console.log("  Purpose: Private");

    // Business -> No
    await page.locator('label:has(input[name="vehicleRegisterInBusinessName"][value="No"])').click();
    await humanDelay(800, 1200);
    console.log("  Business: No");

    await page.screenshot({ path: "test-screenshots/v18-01-car.png", fullPage: true });

    // Continue to About You (with retry)
    console.log("  Clicking Continue...");
    let aboutYouReached = false;
    for (let contAttempt = 1; contAttempt <= 3; contAttempt++) {
      await page.locator('button:has-text("Continue")').click({ force: true });
      aboutYouReached = await waitForText(page, "Already with us?", 20000);
      if (aboutYouReached) break;
      console.log(`  Continue attempt ${contAttempt} didn't advance, retrying...`);
    }
    if (!aboutYouReached) throw new Error("Failed to reach About You page");
    console.log("  -> About You!\n");

    await page.screenshot({ path: "test-screenshots/v18-02-about.png", fullPage: true });

    // ═══ STEP 3: Fill About You ═══
    console.log("STEP 3: Fill About You");
    await humanDelay(2000, 3000);

    // Member -> No
    await page.locator('label:has(input[name="isMember0"][value="No"])').click();
    await humanDelay(800, 1200);
    console.log("  Member: No");

    // Gender -> Female
    await page.locator('label:has(input[name="driverSex0"][value="Female"])').click();
    await humanDelay(800, 1200);
    console.log("  Gender: Female");

    // Age -> 33 (keyboard.type for proper LWC event handling)
    await page.locator('input[name="age0"]').click({ force: true });
    await humanDelay(200, 400);
    await page.keyboard.type("33", { delay: 80 });
    await page.keyboard.press("Tab");
    await humanDelay(500, 800);
    console.log("  Age: 33");

    // Licence age -> 18
    await page.locator('input[name="driverAge0"]').click({ force: true });
    await humanDelay(200, 400);
    await page.keyboard.type("18", { delay: 80 });
    await page.keyboard.press("Tab");
    await humanDelay(500, 800);
    console.log("  Licence age: 18");

    // Accidents -> No
    await page.locator('label:has(input[name="hasClaims0"][value="No"])').click();
    await humanDelay(800, 1200);
    console.log("  Accidents: No");

    await page.screenshot({ path: "test-screenshots/v18-03-driver.png", fullPage: true });

    // Continue to Quotes
    console.log("  Clicking Continue...");
    await page.locator('button:has-text("Continue")').click({ force: true });

    // Wait for quote page (Aura API calls take ~15-20s)
    const quoteReached = await waitForText(page, "/Yearly", 30000);
    if (!quoteReached) {
      // Check for alternative quote indicators
      const body = await page.evaluate(() => document.body.innerText);
      if (!body.includes("Comprehensive") && !body.includes("Your quote summary")) {
        await page.screenshot({ path: "test-screenshots/v18-stuck.png", fullPage: true });
        throw new Error("Failed to reach Quote page");
      }
    }
    console.log("  -> Quote page!\n");

    await page.screenshot({ path: "test-screenshots/v18-04-quote.png", fullPage: true });

    // ═══ STEP 4: Extract Quotes ═══
    console.log("STEP 4: Extract Quotes");
    const pageText = await page.evaluate(() => document.body.innerText);

    // Car + Driver summary
    const carMatch = pageText.match(/(\d{4}\s+[A-Z][A-Za-z]+\s+[A-Z][A-Za-z]+[\w\s]*)/);
    const ageMatch = pageText.match(/Age:\s*(\d+)/);
    const genderMatch = pageText.match(/Gender:\s*(\w+)/);
    const driversMatch = pageText.match(/Additional drivers:\s*(\d+)/);
    console.log(`  Car: ${carMatch?.[1]?.trim() || "?"}`);
    console.log(`  Driver: Age=${ageMatch?.[1] || "?"}, Gender=${genderMatch?.[1] || "?"}, Additional=${driversMatch?.[1] || "0"}`);

    // Comprehensive tab (default)
    console.log("\n  --- COMPREHENSIVE ---");
    for (const name of ["Comprehensive", "Complete Care"]) {
      const idx = pageText.indexOf(name);
      if (idx === -1) continue;
      const chunk = pageText.substring(idx, idx + 500);
      const y = chunk.match(/\$([\d,]+\.?\d*)\s*\/Yearly/);
      const m = chunk.match(/\$([\d,]+\.?\d*)\s*\/Monthly/);
      const t = chunk.match(/\(\$([\d,]+\.?\d*)\s*over 12 months\)/);
      const s = chunk.match(/Save \$([\d,]+\.?\d*)/);
      if (y) {
        let line = `  ${name}: $${y[1]}/yr`;
        if (m) line += ` | $${m[1]}/mo`;
        if (t) line += ` | $${t[1]}/12mo`;
        if (s) line += ` | Save $${s[1]}`;
        console.log(line);
      }
    }

    // Third Party tab
    const tpTab = page.locator('li:has-text("Third Party")').first();
    if ((await tpTab.count()) > 0 && (await tpTab.isVisible())) {
      await tpTab.click();
      await humanDelay(2000, 3000);
      await page.screenshot({ path: "test-screenshots/v18-05-tp.png", fullPage: true });

      const tpText = await page.evaluate(() => document.body.innerText);
      console.log("\n  --- THIRD PARTY ---");
      for (const name of ["Third Party Property Damage", "Third Party Fire & Theft"]) {
        const idx = tpText.indexOf(name);
        if (idx === -1) continue;
        const chunk = tpText.substring(idx, idx + 500);
        const y = chunk.match(/\$([\d,]+\.?\d*)\s*\/Yearly/);
        const m = chunk.match(/\$([\d,]+\.?\d*)\s*\/Monthly/);
        const t = chunk.match(/\(\$([\d,]+\.?\d*)\s*over 12 months\)/);
        const s = chunk.match(/Save \$([\d,]+\.?\d*)/);
        if (y) {
          let line = `  ${name}: $${y[1]}/yr`;
          if (m) line += ` | $${m[1]}/mo`;
          if (t) line += ` | $${t[1]}/12mo`;
          if (s) line += ` | Save $${s[1]}`;
          console.log(line);
        }
      }
    }

    console.log("\n\n=== FULL E2E TEST PASSED ===");
  } catch (err) {
    console.error("\nFailed:", err);
    await page.screenshot({ path: "test-screenshots/error.png", fullPage: true }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    console.log("\nPage at failure (500):", text.substring(0, 500));
  } finally {
    await browser.close();
  }
};

run();

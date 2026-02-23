/**
 * RACV quote flow automation — proven approach from E2E testing.
 *
 * Key findings:
 * - networkidle for initial page load (LWC needs full init)
 * - click({ force: true }) for buttons (label intercepts pointer events)
 * - keyboard.type() for number inputs (triggers proper LWC events)
 * - Poll for page text changes (Aura API calls take 15-20s)
 */
import type { Page } from "playwright";
import { humanDelay } from "./browser.js";
import type {
  CarDetailsInput,
  DriverDetailsInput,
  QuoteResult,
  ProductQuote,
} from "../types.js";

const RACV_URL = "https://my.racv.com.au/s/motor-insurance?p=CAR";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function waitForText(page: Page, text: string, timeoutMs = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes(text)) return true;
    await humanDelay(2000, 2500);
  }
  return false;
}

async function clickContinueAndWait(page: Page, targetText: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await page.locator('button:has-text("Continue")').click({ force: true });
    const found = await waitForText(page, targetText, 45000);
    if (found) return;
    console.log(`  Continue attempt ${attempt}/${maxRetries} — page didn't advance`);
  }
  throw new Error(`Page did not advance to "${targetText}" after ${maxRetries} attempts`);
}

// ─── Step 1a: Find car by rego ──────────────────────────────────────────────

export async function findCarByRego(
  page: Page,
  rego: string,
  state: string
): Promise<string> {
  await page.goto(RACV_URL, { waitUntil: "networkidle", timeout: 90000 });

  await page.locator('input[name="rego"]').waitFor({ timeout: 60000 });
  await humanDelay(2000, 3000);

  await page.locator('input[name="rego"]').fill(rego);
  await page.locator('select[name="jurisdictionFieldValue"]').selectOption({ label: state });
  await humanDelay(800, 1200);
  await page.locator('button:has-text("Find Your car")').click({ force: true });

  // Wait for car details form
  await page.locator('input[name="addressSearch"]').waitFor({ timeout: 45000 });

  // Extract car description from page
  const carDesc = await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/(\d{4}\s+[A-Z][A-Za-z]+\s+[A-Z][A-Za-z]+[\s\S]*?)(?:EDIT|Not your car)/);
    return match?.[1]?.trim() || "Car found";
  });

  return carDesc;
}

// ─── Step 1b: Find car manually ─────────────────────────────────────────────

export async function findCarManually(
  page: Page,
  year: string,
  make: string,
  model: string,
  bodyType: string
): Promise<string> {
  await page.goto(RACV_URL, { waitUntil: "networkidle", timeout: 90000 });
  await page.locator('input[name="rego"]').waitFor({ timeout: 60000 });
  await humanDelay(2000, 3000);

  // Click manual lookup link
  await page.locator('a:has-text("Find your car manually")').click();
  await humanDelay(1500, 2000);

  // Select Year
  const yearSelect = page.locator('select').filter({ hasText: "Year" }).first();
  await yearSelect.selectOption(year);
  await humanDelay(1000, 1500);

  // Select Make
  const makeSelect = page.locator('select').filter({ hasText: "Make" }).first();
  await makeSelect.selectOption(make);
  await humanDelay(1000, 1500);

  // Select Model
  const modelSelect = page.locator('select').filter({ hasText: "Model" }).first();
  await modelSelect.selectOption(model);
  await humanDelay(1000, 1500);

  // Select Body Type
  const bodySelect = page.locator('select').filter({ hasText: "Body" }).first();
  await bodySelect.selectOption(bodyType);
  await humanDelay(1000, 1500);

  // Wait for address field to confirm car selection
  await page.locator('input[name="addressSearch"]').waitFor({ timeout: 15000 });

  return `${year} ${make} ${model} ${bodyType}`;
}

// ─── Step 2: Fill car details ───────────────────────────────────────────────

export async function fillCarDetails(
  page: Page,
  input: CarDetailsInput
): Promise<void> {
  // Address autocomplete (with retry)
  let addressFilled = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.locator('input[name="addressSearch"]').click();
    await humanDelay(300, 500);
    await page.locator('input[name="addressSearch"]').fill("");
    await page.locator('input[name="addressSearch"]').pressSequentially(input.address, { delay: 100 });
    await humanDelay(4000, 6000);

    // Click first suggestion
    const sugg = page.locator("li").filter({ hasText: /\d+.*\w+.*\d{4}/ }).first();
    if ((await sugg.count()) > 0) {
      await sugg.click();
      await humanDelay(1500, 2000);
      const addrVal = await page.locator('input[name="addressSearch"]').inputValue();
      if (addrVal && addrVal.length > 10) {
        addressFilled = true;
        break;
      }
    }

    // Fallback: click any li with street text
    const fallback = page.locator('li:has-text("St"), li:has-text("Rd"), li:has-text("Ave")').first();
    if ((await fallback.count()) > 0) {
      await fallback.click();
      await humanDelay(1500, 2000);
      addressFilled = true;
      break;
    }

    await page.locator('input[name="addressSearch"]').fill("");
    await humanDelay(1000, 2000);
  }

  if (!addressFilled) {
    throw new Error("Failed to fill address via autocomplete");
  }

  // Under finance
  const financeValue = input.underFinance ? "Yes" : "No";
  await page.locator(`label:has(input[name="UnderFinance"][value="${financeValue}"])`).click();
  await humanDelay(800, 1200);

  // Purpose
  await page.locator('select[name="Purpose"]').selectOption(input.purpose);
  await page.locator('select[name="Purpose"]').evaluate((el: any) => {
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  });
  await humanDelay(800, 1200);

  // Business registered
  const businessValue = input.businessRegistered ? "Yes" : "No";
  await page.locator(`label:has(input[name="vehicleRegisterInBusinessName"][value="${businessValue}"])`).click();
  await humanDelay(800, 1200);

  // Cover start date (optional — default is today)
  if (input.coverStartDate) {
    const dateInput = page.locator('input[name="startDate"]');
    if ((await dateInput.count()) > 0) {
      await dateInput.click({ force: true });
      await dateInput.fill(input.coverStartDate);
      await page.keyboard.press("Tab");
      await humanDelay(500, 800);
    }
  }

  // Email (optional)
  if (input.email) {
    const emailInput = page.locator('input[name="email"]');
    if ((await emailInput.count()) > 0) {
      await emailInput.fill(input.email);
      await humanDelay(500, 800);
    }
  }

  // Continue to About You
  await clickContinueAndWait(page, "Already with us?");
}

// ─── Step 3: Fill driver details ────────────────────────────────────────────

export async function fillDriverDetails(
  page: Page,
  input: DriverDetailsInput
): Promise<void> {
  await humanDelay(2000, 3000);

  // Member
  const memberVal = input.racvMember ? "Yes" : "No";
  await page.locator(`label:has(input[name="isMember0"][value="${memberVal}"])`).click();
  await humanDelay(800, 1200);

  // Gender
  const genderVal = input.gender === "male" ? "Male" : "Female";
  await page.locator(`label:has(input[name="driverSex0"][value="${genderVal}"])`).click();
  await humanDelay(800, 1200);

  // Age (keyboard.type for proper LWC event handling)
  await page.locator('input[name="age0"]').click({ force: true });
  await humanDelay(200, 400);
  await page.keyboard.type(input.age.toString(), { delay: 80 });
  await page.keyboard.press("Tab");
  await humanDelay(500, 800);

  // Licence age
  await page.locator('input[name="driverAge0"]').click({ force: true });
  await humanDelay(200, 400);
  await page.keyboard.type(input.licenceAge.toString(), { delay: 80 });
  await page.keyboard.press("Tab");
  await humanDelay(500, 800);

  // Accidents
  const accidentsVal = input.accidentsLast5Years ? "Yes" : "No";
  await page.locator(`label:has(input[name="hasClaims0"][value="${accidentsVal}"])`).click();
  await humanDelay(800, 1200);

  // Continue to Quote Results (Aura API takes 15-20s)
  await page.locator('button:has-text("Continue")').click({ force: true });
  const quoteReached = await waitForText(page, "/Yearly", 60000);
  if (!quoteReached) {
    const body = await page.evaluate(() => document.body.innerText);
    if (!body.includes("Comprehensive") && !body.includes("Your quote summary")) {
      throw new Error("Failed to reach quote results page");
    }
  }
}

// ─── Step 4: Extract quote results ──────────────────────────────────────────

export async function extractQuoteResults(page: Page): Promise<QuoteResult> {
  await humanDelay(1000, 2000);

  const pageText = await page.evaluate(() => document.body.innerText);

  // Car and driver summary
  const carMatch = pageText.match(/(\d{4}\s+[A-Z][A-Za-z]+\s+[A-Z][A-Za-z]+[\w\s]*)/);
  const ageMatch = pageText.match(/Age:\s*(\d+)/);
  const genderMatch = pageText.match(/Gender:\s*(\w+)/);
  const driversMatch = pageText.match(/Additional drivers:\s*(\d+)/);

  // Extract comprehensive quotes (default tab)
  const comprehensive = extractProductsFromText(pageText, [
    "Comprehensive",
    "Complete Care",
  ]);

  // Click Third Party tab and extract
  let thirdParty: ProductQuote[] = [];
  const tpTab = page.locator('li:has-text("Third Party")').first();
  if ((await tpTab.count()) > 0 && (await tpTab.isVisible())) {
    await tpTab.click();
    await humanDelay(2000, 3000);
    const tpText = await page.evaluate(() => document.body.innerText);
    thirdParty = extractProductsFromText(tpText, [
      "Third Party Property Damage",
      "Third Party Fire & Theft",
    ]);
  }

  return {
    car: {
      description: carMatch?.[1]?.trim() || "Unknown",
    },
    driver: {
      age: ageMatch ? parseInt(ageMatch[1]) : 0,
      gender: genderMatch?.[1] || "Unknown",
      additionalDrivers: driversMatch ? parseInt(driversMatch[1]) : 0,
    },
    comprehensive,
    thirdParty,
  };
}

function extractProductsFromText(text: string, productNames: string[]): ProductQuote[] {
  const products: ProductQuote[] = [];

  for (const name of productNames) {
    const idx = text.indexOf(name);
    if (idx === -1) continue;
    const chunk = text.substring(idx, idx + 500);

    const yearly = chunk.match(/\$([\d,]+\.?\d*)\s*\/Yearly/);
    const monthly = chunk.match(/\$([\d,]+\.?\d*)\s*\/Monthly/);
    const total = chunk.match(/\(\$([\d,]+\.?\d*)\s*over 12 months\)/);
    const saving = chunk.match(/Save \$([\d,]+\.?\d*)/);

    if (yearly) {
      products.push({
        name,
        yearlyPrice: `$${yearly[1]}`,
        monthlyPrice: monthly ? `$${monthly[1]}` : "N/A",
        totalOver12Months: total ? `$${total[1]}` : "N/A",
        yearlySaving: saving ? `$${saving[1]}` : undefined,
        features: [],
      });
    }
  }

  return products;
}

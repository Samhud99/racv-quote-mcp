import type { Page, Browser, BrowserContext } from "playwright";

export interface QuoteSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  state: QuoteState;
  createdAt: number;
  lastActivity: number;
}

export type QuoteState =
  | "initialized"
  | "car_found"
  | "car_details_filled"
  | "driver_details_filled"
  | "quote_ready"
  | "error";

export interface CarLookupInput {
  rego?: string;
  state?: string;
  year?: string;
  make?: string;
  model?: string;
  bodyType?: string;
}

export interface CarDetailsInput {
  address: string;
  underFinance: boolean;
  purpose: string;
  businessRegistered: boolean;
  coverStartDate: string; // DD/MM/YYYY
  email?: string;
}

export interface DriverDetailsInput {
  racvMember: boolean;
  gender: "male" | "female";
  age: number;
  licenceAge: number;
  accidentsLast5Years: boolean;
  additionalDrivers?: AdditionalDriver[];
}

export interface AdditionalDriver {
  isOwner: boolean;
  gender: "male" | "female";
  age: number;
  licenceAge: number;
  accidentsLast5Years: boolean;
}

export interface QuoteResult {
  car: {
    description: string;
  };
  driver: {
    age: number;
    gender: string;
    additionalDrivers: number;
  };
  comprehensive: ProductQuote[];
  thirdParty: ProductQuote[];
}

export interface ProductQuote {
  name: string;
  yearlyPrice: string;
  monthlyPrice: string;
  totalOver12Months: string;
  yearlySaving?: string;
  features: string[];
}

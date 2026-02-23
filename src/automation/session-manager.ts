import { v4 as uuid } from "uuid";
import { launchBrowser } from "./browser.js";
import type { QuoteSession, QuoteState } from "../types.js";

const sessions = new Map<string, QuoteSession>();
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function createSession(): Promise<QuoteSession> {
  const { browser, context, page } = await launchBrowser();
  const session: QuoteSession = {
    id: uuid(),
    browser,
    context,
    page,
    state: "initialized",
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(sessionId: string): QuoteSession | undefined {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
  }
  return session;
}

export function updateSessionState(
  sessionId: string,
  state: QuoteState
): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.state = state;
    session.lastActivity = Date.now();
  }
}

export async function destroySession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (session) {
    try {
      await session.context.close();
      await session.browser.close();
    } catch {
      // Browser may already be closed
    }
    sessions.delete(sessionId);
  }
}

export function getActiveSessions(): number {
  return sessions.size;
}

// Clean up expired sessions periodically
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`Cleaning up expired session: ${id}`);
      await destroySession(id);
    }
  }
}, 60_000);

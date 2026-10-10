import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

interface Session {
  appToken?: string;
  personalBaseToken?: string;
  userAccessToken?: string;
  transport: Transport | null;
}

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  createSession(sessionId: string, appToken: string, personalBaseToken: string, transport: Transport | null = null): void {
    this.sessions.set(sessionId, { appToken, personalBaseToken, transport });
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getTransport(sessionId: string): Transport | null {
    return this.sessions.get(sessionId)?.transport ?? null;
  }

  setTransport(sessionId: string, transport: Transport): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.transport = transport;
      this.sessions.set(sessionId, session);
    }
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setUserAccessToken(sessionId: string, userAccessToken: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.userAccessToken = userAccessToken;
      this.sessions.set(sessionId, session);
    } else {
      throw new Error(`Session not found: ${sessionId}`);
    }
  }

  getUserAccessToken(sessionId?: string): string | undefined {
    // console.log('getUserAccessToken', sessionId);
    if (!sessionId) {
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    const token = session?.userAccessToken;
    // console.log('getUserAccessToken userAccessToken', token);

    return token;
  }
}

export const sessionManager = new SessionManager();

export interface Session {
  shop: string;
  accessToken: string;
  scope: string;
  /** Epoch ms. Used to ignore uninstall webhooks from before a reinstall. */
  installedAt: number;
}

export interface SessionStore {
  save(s: Session): Promise<void>;
  get(shop: string): Promise<Session | undefined>;
  delete(shop: string): Promise<void>;
}

/** In-memory store for tests and the demo. Use a database in production. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async save(s: Session): Promise<void> {
    this.sessions.set(s.shop, { ...s });
  }

  async get(shop: string): Promise<Session | undefined> {
    const s = this.sessions.get(shop);
    return s ? { ...s } : undefined;
  }

  async delete(shop: string): Promise<void> {
    this.sessions.delete(shop);
  }
}

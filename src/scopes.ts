/** What a token may be allowed. Pure, so the agents page can list them. */
export const SCOPES = ["tasks:read", "tasks:write", "tasks:complete", "private:read", "private:write", "attachments:write"] as const;
export type Scope = (typeof SCOPES)[number];

export const isScope = (value: unknown): value is Scope => SCOPES.includes(value as Scope);

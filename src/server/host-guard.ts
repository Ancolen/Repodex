import type { NextFunction, Request, Response } from "express";

/**
 * DNS-rebinding protection as an Express middleware: only accept requests whose
 * Host header is the configured bind address or one of the localhost spellings.
 *
 * Binding to 127.0.0.1 alone does NOT stop a malicious web page in the user's
 * browser from reaching these unauthenticated endpoints: a rebound hostname
 * still resolves to 127.0.0.1, and the browser happily sends the request. The
 * Host check is what blocks it (the same defense the MCP SDK transport applies
 * to POST /mcp — this extends it to every other endpoint).
 */
export function hostGuard(
  host: string,
  port: number,
): (req: Request, res: Response, next: NextFunction) => void {
  const allowed = new Set([
    `${host}:${port}`,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  return (req, res, next) => {
    const h = req.headers.host;
    if (typeof h === "string" && allowed.has(h)) next();
    else res.status(403).json({ error: "Invalid Host header" });
  };
}
import type { Hono } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { createAuthState } from "../../state/auth.js";

export function registerLogin(
  app: Hono,
  {
    authState,
    secureCookie,
  }: {
    authState: ReturnType<typeof createAuthState>;
    secureCookie: boolean;
  },
) {
  app.post("/api/login", bodyLimit({ maxSize: 1024 }), async (c) => {
    authState.loginAttempts = authState.loginAttempts.filter(
      (at) => at > Date.now() - 60_000,
    );
    if (authState.loginAttempts.length >= 10)
      return c.text("Too many attempts; wait one minute", 429);
    authState.loginAttempts.push(Date.now());
    let key: unknown;
    try {
      key = (await c.req.json()).key;
    } catch {
      return c.text("Invalid request", 400);
    }
    if (
      typeof key !== "string" ||
      Buffer.byteLength(key) !== Buffer.byteLength(authState.accessKey) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(authState.accessKey))
    )
      return c.text("Invalid access key", 401);
    for (const [id, expiry] of authState.sessions)
      if (expiry <= Date.now()) authState.sessions.delete(id);
    if (authState.sessions.size >= 32)
      authState.sessions.delete(authState.sessions.keys().next().value!);
    const id = randomBytes(32).toString("hex");
    authState.sessions.set(id, Date.now() + authState.sessionTtl);
    setCookie(c, "workbench", id, {
      httpOnly: true,
      sameSite: "Strict",
      secure: secureCookie,
      path: "/",
      maxAge: authState.sessionTtl / 1000,
    });
    return c.json({ ok: true });
  });
}

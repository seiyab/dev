import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { brokerGit, preparePush, remoteRefs } from "./git.js";
import {
  BrokerError,
  isOid,
  isRepositoryId,
  MAX_BUNDLE_BYTES,
  type PushRequest,
  type PullRequestRequest,
} from "./protocol.js";

import type { BrokerConfig } from "./config.js";
import { createUpstreams } from "./upstreams.js";
export type { BrokerConfig } from "./config.js";
interface Ownership {
  boxId: string;
  status: "pending" | "owned";
  tip: string;
}

export async function startGitBroker(config: BrokerConfig) {
  if (
    !config ||
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535 ||
    typeof config.stateDir !== "string" ||
    !isAbsolute(config.stateDir) ||
    !Array.isArray(config.repositories) ||
    !Array.isArray(config.boxes)
  )
    throw new Error("Invalid broker configuration");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const git = brokerGit(config.stateDir);
  if (
    config.hostname !== undefined &&
    !["127.0.0.1", "0.0.0.0"].includes(config.hostname)
  )
    throw new Error("Invalid broker bind address");
  if (
    config.allowedHost !== undefined &&
    !/^[a-z0-9.-]+:[0-9]{1,5}$/.test(config.allowedHost)
  )
    throw new Error("Invalid broker host");
  if (config.hostname === "0.0.0.0" && !config.allowedHost)
    throw new Error("A network broker requires an explicit allowedHost");
  const repositories = await createUpstreams(config);
  const boxes = config.boxes.map((box) => {
    if (
      !box ||
      typeof box.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(box.id) ||
      !Array.isArray(box.repositories) ||
      box.repositories.some((id) => !repositories.has(id)) ||
      typeof box.capabilityFile !== "string" ||
      !isAbsolute(box.capabilityFile)
    )
      throw new Error("Invalid box grant");
    const token = readFileSync(box.capabilityFile, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(token))
      throw new Error(
        "Box capabilities must contain 32 random bytes encoded as hex",
      );
    return { ...box, token: Buffer.from(token) };
  });
  if (
    new Set(boxes.map((b) => b.id)).size !== boxes.length ||
    new Set(boxes.map((b) => b.token.toString())).size !== boxes.length
  )
    throw new Error("Duplicate box identity or capability");

  const stateFile = join(config.stateDir, "ownership.json");
  let ownership: Record<string, Ownership> = {};
  try {
    const stored = JSON.parse(readFileSync(stateFile, "utf8"));
    if (
      stored.version !== 1 ||
      !stored.ownership ||
      typeof stored.ownership !== "object" ||
      Array.isArray(stored.ownership) ||
      Object.entries(stored.ownership).some(([key, value]) => {
        const record = value as Ownership;
        const [repo, ref] = key.split("\0");
        return (
          !isRepositoryId(repo) ||
          !ref?.startsWith("refs/heads/box/") ||
          !record ||
          typeof record.boxId !== "string" ||
          !["pending", "owned"].includes(record.status) ||
          !isOid(record.tip)
        );
      })
    )
      throw new Error("Invalid broker ownership state");
    ownership = stored.ownership;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  function record(key: string, value: Ownership) {
    const next = { ...ownership, [key]: value };
    writeFileSync(
      stateFile + ".tmp",
      JSON.stringify({ version: 1, ownership: next }) + "\n",
      { mode: 0o600, flush: true },
    );
    renameSync(stateFile + ".tmp", stateFile);
    ownership = next;
  }
  const queues = new Map<string, Promise<void>>();
  async function serialize<T>(repository: string, action: () => Promise<T>) {
    const previous = queues.get(repository) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(
      () => {},
      () => {},
    );
    queues.set(repository, tail);
    try {
      return await result;
    } finally {
      if (queues.get(repository) === tail) queues.delete(repository);
    }
  }
  function parsePush(value: unknown): PushRequest {
    if (!value || typeof value !== "object")
      throw new BrokerError("Invalid push request");
    const r = value as PushRequest;
    if (!r.newOid)
      throw new BrokerError("Branch deletion is not permitted", 403);
    if (
      typeof r.ref !== "string" ||
      r.ref.length > 256 ||
      !isOid(r.newOid) ||
      (r.expectedOid !== null && !isOid(r.expectedOid)) ||
      typeof r.dryRun !== "boolean" ||
      typeof r.bundle !== "string" ||
      !r.bundle
    )
      throw new BrokerError("Invalid push request");
    if (r.bundle.length > Math.ceil(MAX_BUNDLE_BYTES / 3) * 4)
      throw new BrokerError("Bundle exceeds prototype size limit", 413);
    const decoded = Buffer.from(r.bundle, "base64");
    if (decoded.length > MAX_BUNDLE_BYTES)
      throw new BrokerError("Bundle exceeds prototype size limit", 413);
    if (decoded.toString("base64") !== r.bundle)
      throw new BrokerError("Invalid bundle encoding");
    return r;
  }

  type Box = (typeof boxes)[number];
  const app = new Hono<{ Variables: { box: Box } }>();
  let port = config.port;
  app.use("*", async (c, next) => {
    if (
      c.req.header("host") !== (config.allowedHost ?? `127.0.0.1:${port}`) ||
      c.req.header("origin")
    )
      return c.text("Unexpected host or browser origin", 403);
    c.header("Cache-Control", "no-store");
    if (c.req.path === "/health" && c.req.method === "GET")
      return c.json({ ok: true });
    const authorization = c.req.header("authorization") ?? "";
    const token = Buffer.from(
      authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
    );
    const box = boxes.find(
      (b) => token.length === b.token.length && timingSafeEqual(token, b.token),
    );
    if (!box) return c.text("Invalid box capability", 401);
    c.set("box", box);
    await next();
  });
  // Typed context below carries only the server-derived grant, never a client box ID.
  const api = new Hono<{ Variables: { box: Box } }>();
  api.use("*", async (c, next) => {
    // Parent middleware sets the grant before this sub-app runs.
    const box = c.get("box");
    const id = `${c.req.param("owner")}/${c.req.param("repo")}`;
    if (!repositories.has(id) || !box.repositories.includes(id))
      return c.text("Repository is not granted to this box", 403);
    await next();
  });
  api.get("/", async (c) => {
    const upstream = repositories.get(
      `${c.req.param("owner")}/${c.req.param("repo")}`,
    )!;
    return c.json({ refs: await remoteRefs(upstream.git, upstream.url) });
  });
  api.post("/push", bodyLimit({ maxSize: 12 * 1024 * 1024 }), async (c) => {
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      throw new BrokerError("Invalid JSON request");
    }
    const request = parsePush(value);
    const box = c.get("box");
    const id = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const upstream = repositories.get(id)!;
    if (!request.ref.startsWith(`refs/heads/box/${box.id}/`))
      throw new BrokerError(
        "Destination is outside this box's branch namespace",
        403,
      );
    try {
      await git(["check-ref-format", request.ref]);
    } catch {
      throw new BrokerError("Invalid branch name");
    }
    return serialize(id, async () => {
      try {
        const refs = await remoteRefs(upstream.git, upstream.url);
        const current =
          refs.find((ref) => ref.name === request.ref)?.oid ?? null;
        const key = `${id}\0${request.ref}`;
        const entry = ownership[key];
        if (
          current &&
          (!entry ||
            entry.boxId !== box.id ||
            (entry.status === "pending" && entry.tip !== current))
        )
          throw new BrokerError(
            "Existing branch is not recorded as owned by this box; trusted reconciliation is required",
            403,
          );
        if (current !== request.expectedOid)
          throw new BrokerError("Upstream changed; fetch and retry", 409);
        const prepared = await preparePush(
          upstream.git,
          config.stateDir,
          upstream.url,
          request,
        );
        try {
          if (!request.dryRun) {
            // Persist a reservation before the upstream write. After a lost reply,
            // only the exact reserved tip can establish ownership of a new branch.
            if (!entry || entry.status === "pending")
              record(key, {
                boxId: box.id,
                status: "pending",
                tip: request.newOid,
              });
            await prepared.push();
            record(key, {
              boxId: box.id,
              status: "owned",
              tip: request.newOid,
            });
          }
        } finally {
          await prepared.dispose();
        }
        appendFileSync(
          join(config.stateDir, "audit.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            boxId: box.id,
            repository: id,
            ref: request.ref,
            oldOid: current,
            newOid: request.newOid,
            outcome: request.dryRun ? "validated-dry-run" : "pushed",
          }) + "\n",
          { mode: 0o600 },
        );
        return c.json({ ok: true, dryRun: request.dryRun });
      } catch (error) {
        appendFileSync(
          join(config.stateDir, "audit.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            boxId: box.id,
            repository: id,
            ref: request.ref,
            outcome: "failed",
            reason:
              error instanceof BrokerError
                ? error.message
                : "Broker operation failed; upstream outcome may be uncertain",
          }) + "\n",
          { mode: 0o600 },
        );
        throw error;
      }
    });
  });
  api.post("/pulls", bodyLimit({ maxSize: 80 * 1024 }), async (c) => {
    let request: PullRequestRequest;
    try {
      request = await c.req.json();
    } catch {
      throw new BrokerError("Invalid JSON request");
    }
    if (
      !request ||
      typeof request.head !== "string" ||
      request.head.length > 245 ||
      typeof request.title !== "string" ||
      !request.title.trim() ||
      request.title.length > 256 ||
      typeof request.body !== "string" ||
      request.body.length > 65536 ||
      typeof request.draft !== "boolean" ||
      (request.base !== undefined &&
        (typeof request.base !== "string" ||
          !request.base ||
          request.base.length > 245))
    )
      throw new BrokerError("Invalid pull request");
    const box = c.get("box");
    const id = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const ref = "refs/heads/" + request.head;
    if (!ref.startsWith(`refs/heads/box/${box.id}/`))
      throw new BrokerError("Head is outside this box's branch namespace", 403);
    try {
      await git(["check-ref-format", ref]);
      if (request.base)
        await git(["check-ref-format", "refs/heads/" + request.base]);
    } catch {
      throw new BrokerError("Invalid branch name");
    }
    return serialize(id, async () => {
      const entry = ownership[`${id}\0${ref}`];
      if (!entry || entry.boxId !== box.id || entry.status !== "owned")
        throw new BrokerError(
          "Branch is not recorded as owned by this box; push it first",
          403,
        );
      const upstream = repositories.get(id)!;
      if (!upstream.createPullRequest)
        throw new BrokerError("Pull requests require a GitHub upstream", 400);
      const refs = await remoteRefs(upstream.git, upstream.url);
      if (!refs.some((r) => r.name === ref))
        throw new BrokerError(
          "Head branch does not exist upstream; push it first",
          409,
        );
      const result = await upstream.createPullRequest(request);
      appendFileSync(
        join(config.stateDir, "audit.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          boxId: box.id,
          repository: id,
          ref,
          outcome: result.created ? "pr-created" : "pr-found",
          number: result.number,
        }) + "\n",
        { mode: 0o600 },
      );
      return c.json(result);
    });
  });
  app.route("/v1/repos/:owner/:repo", api);
  app.onError((error, c) =>
    c.text(
      error instanceof BrokerError
        ? error.message
        : "Broker operation failed; upstream outcome may be uncertain",
      error instanceof BrokerError ? error.status : 502,
    ),
  );
  const server = serve({
    fetch: app.fetch,
    hostname: config.hostname ?? "127.0.0.1",
    port: config.port,
  });
  if ("requestTimeout" in server) server.requestTimeout = 30_000;
  // Resolve an ephemeral test/demo port before accepting requests.
  if (!server.listening)
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export const newCapability = () => randomBytes(32).toString("hex");

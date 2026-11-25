import { get } from "node:http";

// fetch() ignores a custom Host header on the pinned Node version. The broker
// requires its configured Host even when the health probe connects via loopback.
const port = Number(process.argv[2] ?? 3180);
const request = get(
  {
    hostname: "127.0.0.1",
    port,
    path: "/health",
    headers: { Host: "git-broker:3180" },
  },
  (response) => {
    response.resume();
    process.exitCode = response.statusCode === 200 ? 0 : 1;
  },
);
request.setTimeout(4000, () =>
  request.destroy(new Error("Health check timed out")),
);
request.on("error", () => {
  process.exitCode = 1;
});

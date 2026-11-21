import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const oxlint = fileURLToPath(
  new URL("../node_modules/oxlint/bin/oxlint", import.meta.url),
);
const plugin = fileURLToPath(
  new URL("./workbench-oxlint-plugin.js", import.meta.url),
);
const imports =
  'import { mutationOptions, type QueryClient } from "@tanstack/preact-query";\n';

function lint(code, fix = false) {
  const dir = mkdtempSync(join(tmpdir(), "mutation-context-lint-"));
  try {
    const config = join(dir, ".oxlintrc.json");
    const fixture = join(dir, "fixture.ts");
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [{ name: "workbench", specifier: plugin }],
        rules: { "workbench/prefer-mutation-context-client": "warn" },
      }),
    );
    writeFileSync(fixture, code);
    const result = spawnSync(
      process.execPath,
      [
        oxlint,
        "-c",
        config,
        "--format",
        "json",
        ...(fix ? ["--fix"] : []),
        fixture,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return {
      diagnostics: JSON.parse(result.stdout).diagnostics,
      code: readFileSync(fixture, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function warning(code, name = "client") {
  const result = lint(code, true);
  assert.equal(
    result.code,
    code,
    "the rule must not autofix signatures or callers",
  );
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].severity, "warning");
  assert.match(result.diagnostics[0].message, /context\.client/);
  assert.ok(result.diagnostics[0].message.includes(`'${name}'`));
}

test("warns for clients used exclusively in callbacks of returned mutation options", () => {
  warning(
    imports +
      `
export function options(client: QueryClient) {
  return mutationOptions({
    mutationFn: save,
    onSuccess: () => client.invalidateQueries({ queryKey: ["workspace"] }),
    onError(error) { client.setQueryData(["error"], error); },
  });
}`,
  );
});

test("recognizes arrow factories, aliased imports and React Query types", () => {
  warning(
    `import { mutationOptions as options, type QueryClient as Client } from "@tanstack/react-query";
export const makeOptions = (cache: Client) => options({ onSuccess: () => cache.clear() });`,
    "cache",
  );
});

test("recognizes each callback context, including nested closures", () => {
  for (const callback of [
    "mutationFn",
    "onMutate",
    "onSuccess",
    "onError",
    "onSettled",
  ]) {
    warning(
      imports +
        `export const options = (client: QueryClient) => mutationOptions({ ${callback}: () => { return () => client.clear(); } });`,
    );
  }
});

test("aggregates callbacks across alternative returned options", () => {
  warning(
    imports +
      `function options(client: QueryClient, enabled: boolean) {
    if (enabled) return mutationOptions({ onSuccess: () => client.clear() });
    return mutationOptions({ onError: () => client.clear() });
  }`,
  );
});

test("allows clients needed outside mutation callbacks or in callback defaults", () => {
  for (const body of [
    'client.setMutationDefaults(["save"], defaults); return mutationOptions({ onSuccess: () => client.clear() });',
    "return mutationOptions({ meta: { client }, onSuccess: () => client.clear() });",
    "return mutationOptions({ mutationKey: client.getDefaultOptions(), onSuccess: () => client.clear() });",
    "return mutationOptions({ ...client.getDefaultOptions(), onSuccess: () => client.clear() });",
    'return mutationOptions({ onSuccess: (data = client.getQueryData(["default"])) => client.clear() });',
    "const onSuccess = () => client.clear(); return mutationOptions({ onSuccess });",
    "return mutationOptions({ onSuccess: () => { client = replacement; client.clear(); } });",
    "return mutationOptions({ arbitraryCallback: () => client.clear() });",
  ]) {
    assert.deepEqual(
      lint(imports + `function options(client: QueryClient) { ${body} }`)
        .diagnostics,
      [],
    );
  }
});

test("does not confuse shadowed callback parameters with the outer client", () => {
  assert.deepEqual(
    lint(
      imports +
        `function options(client: QueryClient) {
    return mutationOptions({ onSuccess: (client) => client.clear() });
  }`,
    ).diagnostics,
    [],
  );
});

test("does not infer untyped, optional, destructured, unrelated or shadowed imports", () => {
  const valid = [
    imports +
      "function options(client) { return mutationOptions({ onSuccess: () => client.clear() }); }",
    imports +
      "function options(client?: QueryClient) { return mutationOptions({ onSuccess: () => client?.clear() }); }",
    imports +
      "function options({ client }: { client: QueryClient }) { return mutationOptions({ onSuccess: () => client.clear() }); }",
    'import { mutationOptions, QueryClient } from "other-library"; function options(client: QueryClient) { return mutationOptions({ onSuccess: () => client.clear() }); }',
    imports +
      "function options(client: QueryClient, mutationOptions) { return mutationOptions({ onSuccess: () => client.clear() }); }",
    'import { mutationOptions } from "@tanstack/preact-query"; class QueryClient {} function options(client: QueryClient) { return mutationOptions({ onSuccess: () => client.clear() }); }',
    imports +
      "function options(client: QueryClient) { const result = mutationOptions({ onSuccess: () => client.clear() }); return result; }",
    imports +
      "function options(client: QueryClient) { return useMutation({ onSuccess: () => client.clear() }); }",
    imports +
      "function options(client: QueryClient) { return mutationOptions({ mutationFn: save }); }",
  ];
  for (const code of valid) assert.deepEqual(lint(code).diagnostics, [], code);
});

test("allows context.client without an injected client", () => {
  assert.deepEqual(
    lint(
      imports +
        `export const options = mutationOptions({
    onSuccess: (_data, _variables, _onMutateResult, { client }) => client.clear(),
  });`,
    ).diagnostics,
    [],
  );
});

test("recognizes QueryClient types imported separately from query-core", () => {
  warning(`import { mutationOptions } from "@tanstack/preact-query";
import type { QueryClient as Cache } from "@tanstack/query-core";
export function options(client: Cache) {
  return mutationOptions({ "onSuccess": () => client.clear() });
}`);
});

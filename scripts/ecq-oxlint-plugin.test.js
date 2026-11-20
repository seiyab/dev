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
  new URL("./ecq-oxlint-plugin.js", import.meta.url),
);
const prefix =
  'import { ecq } from "@seiyab/ecq";\nconst workspaceQuery = ecq.query(async () => ({}));\n';
const methods = [
  "invalidateQueries",
  "removeQueries",
  "refetchQueries",
  "resetQueries",
  "cancelQueries",
  "getQueriesData",
  "setQueriesData",
  "isFetching",
];

function lint(code, { fix = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ecq-lint-"));
  try {
    const config = join(dir, ".oxlintrc.json");
    const fixture = join(dir, "fixture.ts");
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [{ name: "ecq", specifier: plugin }],
        rules: { "ecq/filter-keys": ["error", { queryModules: ["./api.js"] }] },
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
    assert.ok(
      result.status === 0 || result.status === 1,
      result.stderr || result.stdout,
    );
    const output = JSON.parse(result.stdout);
    assert.equal(
      output.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("Error running"),
      ),
      false,
      result.stdout,
    );
    return {
      diagnostics: output.diagnostics,
      code: readFileSync(fixture, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reports each supported filter method, including computed properties", () => {
  const code =
    prefix +
    methods
      .map(
        (method) =>
          `client.${method}({ queryKey: workspaceQuery().queryKey });`,
      )
      .join("\n") +
    '\nclient["cancelQueries"]({ "queryKey": workspaceQuery()["queryKey"], exact: false });';
  const result = lint(code);
  assert.equal(result.diagnostics.length, methods.length + 1);
  assert.ok(
    result.diagnostics.every((diagnostic) =>
      diagnostic.message.includes("ecq.keyOf(workspaceQuery)"),
    ),
  );
});

test("autofixes known local factories and preserves exact cache operations", () => {
  const code =
    prefix +
    "client.invalidateQueries({ queryKey: workspaceQuery().queryKey });\nclient.getQueryData(workspaceQuery().queryKey);\nclient.setQueryData(workspaceQuery().queryKey, state);";
  const result = lint(code, { fix: true });
  assert.equal(
    result.code,
    code.replace(
      "queryKey: workspaceQuery().queryKey",
      "queryKey: ecq.keyOf(workspaceQuery)",
    ),
  );
  assert.deepEqual(result.diagnostics, []);
});

test("recognizes configured query imports without adding missing ECQ bindings", () => {
  const code =
    'import { workspaceQuery as workspace } from "./api.js";\nclient.removeQueries({ queryKey: workspace().queryKey });';
  const result = lint(code, { fix: true });
  assert.equal(result.code, code);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0].message, /ecq\.keyOf\(workspace\)/);
});

test("reuses aliased and namespace ECQ imports and recognizes client methods", () => {
  for (const [declaration, receiver] of [
    ['import { ecq as queries } from "@seiyab/ecq";', "queries"],
    ['import * as queries from "@seiyab/ecq";', "queries.ecq"],
  ]) {
    const code = `${declaration}\nconst api = ${receiver}.client({ list: async () => [] });\nclient.refetchQueries({ queryKey: api.list().queryKey });`;
    const result = lint(code, { fix: true });
    assert.equal(
      result.code,
      code.replace("api.list().queryKey", `${receiver}.keyOf(api.list)`),
    );
    assert.deepEqual(result.diagnostics, []);
  }
});

test("does not autofix using a shadowed ECQ import", () => {
  const code =
    'import { ecq } from "@seiyab/ecq";\nimport { workspaceQuery } from "./api.js";\nfunction update(ecq) { client.cancelQueries({ queryKey: workspaceQuery().queryKey }); }';
  const result = lint(code, { fix: true });
  assert.equal(result.code, code);
  assert.equal(result.diagnostics.length, 1);
});

test("leaves exact, parameterized, dynamic, spread, and non-ECQ filters alone", () => {
  const code =
    prefix +
    `
import { otherQuery } from "./other.js";
client.invalidateQueries({ queryKey: ecq.keyOf(workspaceQuery) });
client.invalidateQueries({ queryKey: workspaceQuery().queryKey, exact: true });
client.invalidateQueries({ queryKey: workspaceQuery().queryKey, exact: isExact });
client.invalidateQueries({ queryKey: workspaceQuery(42).queryKey });
client.invalidateQueries({ ...filters, queryKey: workspaceQuery().queryKey });
client.invalidateQueries({ queryKey: workspaceQuery().queryKey, ...filters });
client.invalidateQueries({ queryKey: workspaceQuery().queryKey, [dynamicKey]: true });
let mutableQuery = ecq.query(load);
client.invalidateQueries({ queryKey: mutableQuery().queryKey });
client.invalidateQueries({ queryKey: otherQuery().queryKey });
client.invalidateQueries({ queryKey: ["workspace"] });
client.invalidateQueries(filters);
client.fetchQuery({ queryKey: workspaceQuery().queryKey, queryFn: load });
function shadow(workspaceQuery) { client.invalidateQueries({ queryKey: workspaceQuery().queryKey }); }
`;
  assert.deepEqual(lint(code).diagnostics, []);
});

test("does not autofix expressions containing comments", () => {
  const code =
    prefix +
    "client.invalidateQueries({ queryKey: workspaceQuery(/* keep */).queryKey });";
  const result = lint(code, { fix: true });
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.code, code);
});

test("autofixes multiple filters in one pass", () => {
  const code =
    prefix +
    "client.cancelQueries({ queryKey: workspaceQuery().queryKey });\nclient.invalidateQueries({ queryKey: workspaceQuery().queryKey });";
  const result = lint(code, { fix: true });
  assert.equal(
    result.code,
    code.replaceAll("workspaceQuery().queryKey", "ecq.keyOf(workspaceQuery)"),
  );
  assert.deepEqual(result.diagnostics, []);
});

import { defineConfig } from "oxlint";
import queryPlugin from "@tanstack/eslint-plugin-query";
import { preset, ruleName } from "./scripts/preact-oxlint-plugin.js";

export default defineConfig({
  categories: { correctness: "error" },
  ignorePatterns: ["**/dist/**"],
  settings: preset.settings,
  jsPlugins: [
    { name: "preact", specifier: "./scripts/preact-oxlint-plugin.js" },
    "@tanstack/eslint-plugin-query",
    { name: "ecq", specifier: "./scripts/ecq-oxlint-plugin.js" },
    { name: "workbench", specifier: "./scripts/workbench-oxlint-plugin.js" },
  ],
  overrides: [
    {
      files: ["apps/web/**/*.{js,jsx,ts,tsx}"],
      // Use the preset's plugin rules; keep Oxlint's existing core rule policy.
      rules: {
        ...queryPlugin.configs.recommended.rules,
        "workbench/prefer-mutation-context-client": "warn",
        "ecq/filter-keys": ["error", { queryModules: ["./api.js"] }],
        ...Object.fromEntries(
          Object.entries(preset.rules)
            .filter(([name]) => name.includes("/"))
            .map(([name, value]) => [`preact/${ruleName(name)}`, value]),
        ),
      },
    },
  ],
});

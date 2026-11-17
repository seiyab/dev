import preact from "eslint-config-preact";

// ESLint configs aren't plugins. Expose their plugin rules under one Oxlint
// namespace, avoiding Oxlint's reserved native `react` namespace.
export const preset = preact.find((config) => config.plugins);

export const ruleName = (name) => name.replace("/", "-");

export default {
  meta: { name: "preact" },
  rules: Object.fromEntries(
    Object.entries(preset.plugins).flatMap(([name, plugin]) =>
      Object.entries(plugin.rules).map(([rule, implementation]) => [
        ruleName(`${name}/${rule}`),
        implementation,
      ]),
    ),
  ),
};

const queryPackages = new Set([
  "@tanstack/preact-query",
  "@tanstack/react-query",
  "@tanstack/query-core",
]);
const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const mutationCallbacks = new Set([
  "mutationFn",
  "onMutate",
  "onSuccess",
  "onError",
  "onSettled",
]);

const preferMutationContextClient = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Use mutation callback context instead of an injected QueryClient",
    },
    schema: [],
    messages: {
      useContext:
        "Use the mutation callbacks' context.client instead of passing '{{name}}' into this options factory.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    const factories = new Map();

    function variable(node) {
      for (let scope = source.getScope(node); scope; scope = scope.upper) {
        const found = scope.set.get(node.name);
        if (found) return found;
      }
    }
    function imported(node, name, allowType = false) {
      if (node.type !== "Identifier") return false;
      const definition = variable(node)?.defs[0];
      if (definition?.type !== "ImportBinding") return false;
      const specifier = definition.node;
      const declaration = specifier.parent;
      return (
        queryPackages.has(declaration.source.value) &&
        specifier.type === "ImportSpecifier" &&
        specifier.imported.name === name &&
        (allowType ||
          (specifier.importKind !== "type" &&
            declaration.importKind !== "type"))
      );
    }

    return {
      CallExpression(node) {
        if (node.optional || !imported(node.callee, "mutationOptions")) return;
        let factory = node.parent;
        if (factory.type === "ReturnStatement") {
          while (factory && !functionTypes.has(factory.type))
            factory = factory.parent;
        } else if (
          factory.type !== "ArrowFunctionExpression" ||
          factory.body !== node
        ) {
          return;
        }
        if (!factory) return;
        const options = node.arguments[0];
        if (options?.type !== "ObjectExpression") return;
        const callbacks = factories.get(factory) ?? [];
        for (const property of options.properties) {
          if (property.type !== "Property" || property.kind !== "init")
            continue;
          const name = property.computed
            ? property.key.value
            : (property.key.name ?? property.key.value);
          if (
            !mutationCallbacks.has(name) ||
            !functionTypes.has(property.value.type)
          )
            continue;
          // Only callback bodies have access to their context argument. A default
          // parameter expression may execute before that argument is initialized.
          callbacks.push(property.value.body);
        }
        factories.set(factory, callbacks);
      },
      "Program:exit"() {
        for (const [factory, callbacks] of factories) {
          for (const parameter of factory.params) {
            if (parameter.type !== "Identifier" || parameter.optional) continue;
            const type = parameter.typeAnnotation?.typeAnnotation;
            if (
              type?.type !== "TSTypeReference" ||
              !imported(type.typeName, "QueryClient", true)
            )
              continue;
            const binding = source
              .getDeclaredVariables(factory)
              .find((item) =>
                item.defs.some(
                  (definition) =>
                    definition.type === "Parameter" &&
                    definition.name === parameter,
                ),
              );
            if (!binding?.references.length) continue;
            // Any use outside these returned callbacks, or reassignment, means
            // the parameter may be necessary. Do not suggest removing it.
            if (
              !binding.references.every(
                (reference) =>
                  !reference.isWrite() &&
                  callbacks.some(
                    (body) =>
                      body.range[0] <= reference.identifier.range[0] &&
                      reference.identifier.range[1] <= body.range[1],
                  ),
              )
            )
              continue;
            context.report({
              node: parameter,
              messageId: "useContext",
              data: { name: parameter.name },
            });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "workbench" },
  rules: { "prefer-mutation-context-client": preferMutationContextClient },
};

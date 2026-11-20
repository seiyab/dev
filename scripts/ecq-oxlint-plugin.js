const filterMethods = new Set([
  "invalidateQueries",
  "removeQueries",
  "refetchQueries",
  "resetQueries",
  "cancelQueries",
  "getQueriesData",
  "setQueriesData",
  "isFetching",
]);

function propertyName(node) {
  if (!node.computed && node.property?.type === "Identifier")
    return node.property.name;
  if (node.property?.type === "Literal") return node.property.value;
  if (!node.computed && node.key?.type === "Identifier") return node.key.name;
  if (node.key?.type === "Literal") return node.key.value;
}

const filterKeys = {
  meta: {
    type: "suggestion",
    docs: { description: "Use ECQ family keys for non-exact query filters" },
    fixable: "code",
    schema: [
      {
        type: "object",
        properties: {
          queryModules: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      familyKey:
        "Use ecq.keyOf({{factory}}) for this query filter instead of calling the factory for its queryKey.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    // Imports from these modules are trusted query factories when called for a
    // queryKey. Local factories are recognized through their ECQ definitions.
    const queryModules = new Set(context.options[0]?.queryModules ?? []);
    const ecqImports = [];

    function variable(node) {
      for (let scope = source.getScope(node); scope; scope = scope.upper) {
        const found = scope.set.get(node.name);
        if (found) return found;
      }
    }
    function importOf(node) {
      if (node.type !== "Identifier") return;
      const definition = variable(node)?.defs[0];
      if (definition?.type !== "ImportBinding") return;
      const declaration = definition.node.parent;
      if (
        declaration.importKind === "type" ||
        definition.node.importKind === "type"
      )
        return;
      return { specifier: definition.node, module: declaration.source.value };
    }
    function isEcq(node) {
      const imported = importOf(node);
      if (
        imported?.module === "@seiyab/ecq" &&
        imported.specifier.imported?.name === "ecq"
      )
        return true;
      if (
        node.type !== "MemberExpression" ||
        node.optional ||
        propertyName(node) !== "ecq"
      )
        return false;
      const namespace = importOf(node.object);
      return (
        namespace?.module === "@seiyab/ecq" &&
        namespace.specifier.type === "ImportNamespaceSpecifier"
      );
    }
    function ecqDefinition(node, method) {
      if (node.type !== "Identifier") return false;
      const definition = variable(node)?.defs[0];
      const init =
        definition?.type === "Variable" &&
        definition.parent.kind === "const" &&
        definition.node.init;
      return (
        init?.type === "CallExpression" &&
        !init.optional &&
        init.callee.type === "MemberExpression" &&
        !init.callee.optional &&
        propertyName(init.callee) === method &&
        isEcq(init.callee.object)
      );
    }
    function isFactory(node) {
      if (node.type === "Identifier") {
        const imported = importOf(node);
        return (
          (imported && queryModules.has(imported.module)) ||
          ecqDefinition(node, "query")
        );
      }
      return (
        node.type === "MemberExpression" &&
        !node.optional &&
        !node.computed &&
        (ecqDefinition(node.object, "client") ||
          (importOf(node.object)?.specifier.type ===
            "ImportNamespaceSpecifier" &&
            queryModules.has(importOf(node.object).module)))
      );
    }
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@seiyab/ecq" || node.importKind === "type")
          return;
        for (const specifier of node.specifiers) {
          if (
            specifier.importKind !== "type" &&
            (specifier.imported?.name === "ecq" ||
              specifier.type === "ImportNamespaceSpecifier")
          )
            ecqImports.push(specifier);
        }
      },
      CallExpression(node) {
        if (
          node.optional ||
          node.callee.type !== "MemberExpression" ||
          node.callee.optional ||
          !filterMethods.has(propertyName(node.callee))
        )
          return;
        const filters = node.arguments[0];
        if (
          filters?.type !== "ObjectExpression" ||
          filters.properties.some(
            (property) =>
              property.type !== "Property" ||
              (property.computed && property.key.type !== "Literal"),
          )
        )
          return;
        // A spread or a dynamic exact flag may deliberately request exact matching.
        const exact = filters.properties.filter(
          (property) => propertyName(property) === "exact",
        );
        if (
          exact.some(
            (property) =>
              property.value.type !== "Literal" ||
              property.value.value !== false,
          )
        )
          return;
        const keys = filters.properties.filter(
          (property) => propertyName(property) === "queryKey",
        );
        if (keys.length !== 1 || keys[0].kind !== "init") return;
        const key = keys[0].value;
        if (
          key.type !== "MemberExpression" ||
          key.optional ||
          propertyName(key) !== "queryKey"
        )
          return;
        const call = key.object;
        // Arguments may intentionally select one member of a query family.
        if (
          call.type !== "CallExpression" ||
          call.optional ||
          call.arguments.length !== 0 ||
          !isFactory(call.callee)
        )
          return;
        // Preserve comments rather than silently removing them in an autofix.
        const hasComments = source.getCommentsInside(key).length > 0;
        context.report({
          node: key,
          messageId: "familyKey",
          data: { factory: source.getText(call.callee) },
          fix: hasComments
            ? null
            : (fixer) => {
                let receiver;
                for (const specifier of ecqImports) {
                  // Resolve at the use site, including shadowing in nested scopes.
                  let scope = source.getScope(key);
                  while (scope && !scope.set.has(specifier.local.name))
                    scope = scope.upper;
                  if (
                    scope?.set.get(specifier.local.name)?.defs[0]?.node !==
                    specifier
                  )
                    continue;
                  receiver =
                    specifier.local.name +
                    (specifier.type === "ImportNamespaceSpecifier"
                      ? ".ecq"
                      : "");
                  break;
                }
                // Without an unshadowed ECQ import, report without rewriting
                // imports or introducing a binding that might collide.
                if (!receiver) return null;
                return fixer.replaceText(
                  key,
                  `${receiver}.keyOf(${source.getText(call.callee)})`,
                );
              },
        });
      },
    };
  },
};

export default { meta: { name: "ecq" }, rules: { "filter-keys": filterKeys } };

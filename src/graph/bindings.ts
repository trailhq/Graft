/**
 * Receiver-type binding pass: a pre-order walk over a parsed file that answers,
 * for every local variable / parameter / class field / `self`|`this` attribute,
 * "what type is this?" — so a later member-call site (`app.include_router()`)
 * can look up `app`'s bound type instead of resolving on the bare method name
 * alone. Pure and dependency-only: no LLM, no network, no mutation of the AST.
 *
 * Only `import type` from extract.ts (never a value) — extract.ts imports
 * `collectBindings` from here, so a value import back would be a cycle.
 */
import type Parser from "tree-sitter";
import type { Language, WalkCtx } from "./extract.js";

/** Variable/field → bare type name, keyed by scope. Scope keys mirror
 * extract.ts's own scope stack (`scope.join(".")`, `""` at module level) so a
 * lookup from extract.ts's walk finds exactly what was bound in the same
 * lexical position. */
export class FileBindings {
  private map = new Map<string, string>();

  set(scopePath: string, name: string, type: string): void {
    this.map.set(`${scopePath}|${name}`, type);
  }

  /** Innermost-first: for scope ["a","b"] name "x", tries `a.b|x`, `a|x`, `|x`. */
  lookup(scope: string[], name: string): string | null {
    for (let i = scope.length; i >= 0; i--) {
      const hit = this.map.get(`${scope.slice(0, i).join(".")}|${name}`);
      if (hit) return hit;
    }
    return null;
  }
}

const FN_VALUE_TYPES = new Set(["arrow_function", "function", "function_expression", "generator_function"]);

/** Definition-node types that push a new scope segment, mirroring extract.ts's
 * `describe()` closely enough to keep the two scope stacks in lockstep — but
 * duplicated here (not imported) to keep bindings.ts free of a value import on
 * extract.ts. Returns the def's scope segment (bare name, except a Go method
 * which is receiver-qualified — `Receiver.method` — exactly like extract.ts's
 * `idName`, so a binding recorded inside a Go method body is stored under the
 * same scope key extract.ts's walk will look it up with), or null if `node`
 * isn't a definition. */
export function defName(node: Parser.SyntaxNode, lang: Language): string | null {
  if (lang === "go") {
    if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const recv = goReceiverTypeOf(node);
      return recv ? `${recv}.${name}` : name;
    }
    if (node.type === "function_declaration" || node.type === "type_spec") {
      return node.childForFieldName("name")?.text ?? null;
    }
    return null;
  }
  if (lang === "cpp") {
    if (node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "enum_specifier") {
      return node.childForFieldName("name")?.text ?? null;
    }
    if (node.type === "function_definition") {
      const declarator = node.childForFieldName("declarator");
      const resolved = declarator ? cppDeclaratorName(declarator) : null;
      if (!resolved) return null;
      return resolved.scope ? `${resolved.scope}.${resolved.name}` : resolved.name;
    }
    return null;
  }
  if (lang === "r") return rDefName(node);
  const defTypes =
    lang === "python"
      ? new Set(["class_definition", "function_definition"])
      : new Set([
          "class_declaration",
          "abstract_class_declaration",
          "function_declaration",
          "generator_function_declaration",
          "method_definition",
          "interface_declaration",
          "type_alias_declaration",
          "enum_declaration",
        ]);
  if (defTypes.has(node.type)) return node.childForFieldName("name")?.text ?? null;
  if ((lang === "typescript" || lang === "tsx") && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FN_VALUE_TYPES.has(value.type)) return node.childForFieldName("name")?.text ?? null;
  }
  return null;
}

const R_ASSIGN_OPS = new Set(["<-", "<<-", "="]);
const R_RIGHT_ASSIGN_OPS = new Set(["->", "->>"]);

/**
 * The bare name a `binary_operator` (left-assign) or `function_definition`
 * (right-assign) node defines, for R's two plain-function assignment shapes —
 * this file's own `defName` uses it directly. extract.ts's `describeR`
 * duplicates the same op-filtering check rather than importing this (same
 * reasoning as the Go receiver helpers below: bindings.ts can't take a value
 * import back on extract.ts), and additionally needs to distinguish an S3
 * `generic.Class` method and R6/S4 class/method shapes this function doesn't
 * know about — bindings.ts has no equivalent need since no `handleR` binding
 * collector exists yet (R6/S4/S3 don't get a member/receiver-type table in
 * this pass; `self`/`private` resolve directly via `ctx.enclosingClass`
 * instead, needing no lookup). See `describeR`'s doc comment for why
 * right-assign's AST shape needs its own branch rather than mirroring
 * left-assign's (empirically, not assumed — `->`'s low precedence means it's
 * absorbed into the function's own `body` field, not an outer wrapper).
 * Null if `node` isn't one of these two shapes.
 */
export function rDefName(node: Parser.SyntaxNode): string | null {
  if (node.type === "binary_operator") {
    const op = node.childForFieldName("operator")?.text;
    if (!op || !R_ASSIGN_OPS.has(op)) return null;
    const lhs = node.childForFieldName("lhs");
    const rhs = node.childForFieldName("rhs");
    return lhs?.type === "identifier" && rhs?.type === "function_definition" ? lhs.text : null;
  }
  if (node.type === "function_definition") {
    const body = node.childForFieldName("body");
    if (body?.type !== "binary_operator") return null;
    const op = body.childForFieldName("operator")?.text;
    if (!op || !R_RIGHT_ASSIGN_OPS.has(op)) return null;
    const rhs = body.childForFieldName("rhs");
    return rhs?.type === "identifier" ? rhs.text : null;
  }
  return null;
}

/** The receiver parameter's own variable name for a Go method (`func (w *Worker) …`
 * → `w`). Null if it can't be read. */
export function goReceiverVarOf(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver");
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  return param?.childForFieldName("name")?.text ?? null;
}

/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (w *Worker) …` → `Worker`). Mirrors extract.ts's own `goReceiverType`
 * (duplicated, not imported, per this file's no-value-import-of-extract rule).
 * Null if it can't be read. */
function goReceiverTypeOf(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver");
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  let type = param?.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
  return type?.type === "type_identifier" ? type.text : null;
}

/** Unwraps a C++ declarator through pointer/reference wrapping (`int* p`, `int& r`)
 * down to the innermost concrete declarator — a `function_declarator` for a
 * function/method, or a bare name node (`field_identifier`/`identifier`) for a
 * plain variable/field. `reference_declarator` carries its inner declarator as an
 * anonymous first child (no field), unlike `pointer_declarator`'s `declarator`
 * field, so the two branches unwrap differently. Null if the chain bottoms out. */
function unwrapCppDeclarator(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node ?? null;
  while (cur && (cur.type === "pointer_declarator" || cur.type === "reference_declarator")) {
    cur = cur.type === "pointer_declarator" ? cur.childForFieldName("declarator") : (cur.namedChildren[0] ?? null);
  }
  return cur;
}

/** Recursively resolves a (possibly nested) `qualified_identifier`'s innermost name
 * node and immediate scope text — e.g. `ns::Foo::bar` -> `{ scope: "Foo", nameNode: bar }`.
 * Nesting arises from namespace-qualified out-of-class definitions (`void ns::Foo::bar()`);
 * the innermost scope is the one that matters (the actual owning class), not the outer
 * namespace, so recursion always keeps the deepest level. */
export function resolveCppQualified(node: Parser.SyntaxNode): { scope: string | null; nameNode: Parser.SyntaxNode } {
  const name = node.childForFieldName("name");
  const scope = node.childForFieldName("scope");
  if (name?.type === "qualified_identifier") return resolveCppQualified(name);
  return { scope: scope ? stripCppTemplateArgs(scope.text) : null, nameNode: name ?? node };
}

/** Strips trailing `<...>` template arguments from a scope/base-class name
 * (`Foo<T>` -> `Foo`) so it matches the plain name the class node itself carries.
 * v1 doesn't model template specialization identity — see the plan's known gaps. */
export function stripCppTemplateArgs(text: string): string {
  const i = text.indexOf("<");
  return i === -1 ? text : text.slice(0, i);
}

/** The bare name + owning-class scope (non-null only for an out-of-class definition,
 * e.g. `Foo::bar`) for a C++ function-like declarator — the `declarator` field of a
 * `function_definition`. Shared by extract.ts's `describeCpp` (the node's own name/kind)
 * and this file's `defName` (the scope-stack segment), so the two can never drift on
 * how a declarator is unwrapped — unlike the Go receiver helpers, which duplicate
 * across the two files per this file's own no-value-import-of-extract rule, this one
 * only flows extract.ts -> bindings.ts, the direction that's already a value import. */
export function cppDeclaratorName(declarator: Parser.SyntaxNode): { name: string; scope: string | null } | null {
  const fnDecl = unwrapCppDeclarator(declarator);
  if (!fnDecl || fnDecl.type !== "function_declarator") return null;
  const inner = fnDecl.childForFieldName("declarator");
  if (!inner) return null;
  if (inner.type === "qualified_identifier") {
    const { scope, nameNode } = resolveCppQualified(inner);
    return nameNode.text ? { name: nameNode.text, scope } : null;
  }
  if (
    inner.type === "identifier" ||
    inner.type === "field_identifier" ||
    inner.type === "destructor_name" ||
    inner.type === "operator_name"
  ) {
    return inner.text ? { name: inner.text, scope: null } : null;
  }
  return null;
}

/** Resolves a call site's receiver text (from `calleeName`) to a bound type
 * name, given the enclosing walk state. `self`/`cls`/`this`/the Go receiver
 * var resolve directly to the enclosing class; R6's `super` (Phase 3) resolves
 * to the PARENT class instead (`ctx.rSuperClass`, not `ctx.enclosingClass` —
 * a `super$method()` call must climb past the current class's own same-named
 * override, not find it); anything else is a bindings-map lookup, normalizing
 * `this.` to `self.` since both are stored the same way. */
export function resolveRecvType(
  receiver: string | undefined,
  ctx: Pick<WalkCtx, "scope" | "enclosingClass" | "goReceiverVar" | "lang" | "bindings" | "rSuperClass">,
): string | undefined {
  if (!receiver) return undefined;
  if (receiver === "self" || receiver === "cls" || receiver === "this") return ctx.enclosingClass ?? undefined;
  if (receiver === "super") return ctx.rSuperClass ?? undefined;
  if (receiver.startsWith("self.") || receiver.startsWith("this.")) {
    return (
      ctx.bindings.lookup(ctx.scope, receiver) ??
      ctx.bindings.lookup(ctx.scope, receiver.replace(/^this\./, "self.")) ??
      undefined
    );
  }
  return (
    (ctx.lang === "go" && receiver === ctx.goReceiverVar ? ctx.enclosingClass : undefined) ??
    ctx.bindings.lookup(ctx.scope, receiver) ??
    undefined
  );
}

function isClassNode(node: Parser.SyntaxNode, lang: Language): boolean {
  if (lang === "python") return node.type === "class_definition";
  if (lang === "cpp") return node.type === "class_specifier" || node.type === "struct_specifier";
  if (lang === "typescript" || lang === "tsx") {
    return node.type === "class_declaration" || node.type === "abstract_class_declaration";
  }
  return false;
}

/** Pass 1 over a parsed file: collect variable->type bindings. Pure. */
export function collectBindings(root: Parser.SyntaxNode, lang: Language): FileBindings {
  const bindings = new FileBindings();
  const aliases = new Map<string, string>();
  collectAliases(root, lang, aliases);
  visit(root, lang, [], null, bindings, aliases);
  return bindings;
}

/** Import aliases (`... as F`) can be declared anywhere relative to their use
 * textually, so this scans the whole tree once, ahead of the scope-aware walk. */
function collectAliases(node: Parser.SyntaxNode, lang: Language, aliases: Map<string, string>): void {
  if (lang === "python" && node.type === "aliased_import") {
    const nameNode = node.childForFieldName("name");
    const aliasNode = node.childForFieldName("alias");
    if (nameNode && aliasNode) {
      const orig = nameNode.type === "dotted_name" ? (nameNode.namedChildren.at(-1)?.text ?? nameNode.text) : nameNode.text;
      aliases.set(aliasNode.text, orig);
    }
  } else if ((lang === "typescript" || lang === "tsx") && node.type === "import_specifier") {
    const nameNode = node.childForFieldName("name");
    const aliasNode = node.childForFieldName("alias");
    if (nameNode && aliasNode) aliases.set(aliasNode.text, nameNode.text);
  }
  for (const child of node.namedChildren) collectAliases(child, lang, aliases);
}

/** `scope`/`classScope` mirror extract.ts's walk: `scope` is the enclosing
 * definition-name stack; `classScope` is the nearest enclosing class's scope
 * path (distinct from `scope` once we're inside one of its methods) — that's
 * where `self.attr`/`this.attr` bindings live. */
function visit(
  node: Parser.SyntaxNode,
  lang: Language,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  if (lang === "python") handlePy(node, scope, classScope, bindings, aliases);
  else if (lang === "go") handleGo(node, scope, bindings);
  else if (lang === "cpp") handleCpp(node, scope, classScope, bindings, aliases);
  // R has no member/receiver-type binding table — self/private/super resolve
  // directly via ctx.enclosingClass/ctx.rSuperClass instead (see extract.ts's
  // calleeName R branch) — so no handleR is needed here.
  else if (lang === "r") void 0;
  else handleTs(node, scope, classScope, bindings, aliases);

  const name = defName(node, lang);
  let childScope = scope;
  let childClassScope = classScope;
  if (name !== null) {
    childScope = [...scope, name];
    if (isClassNode(node, lang)) childClassScope = childScope.join(".");
  }
  for (const child of node.namedChildren) visit(child, lang, childScope, childClassScope, bindings, aliases);
}

/** Resolves a bare type name through `aliases` — every annotation path must
 * consult it, so an aliased import (`import Foo as Bar`) still binds to the
 * original name callers actually search for. See the "aliases already
 * resolved" contract above. */
function resolveAlias(name: string, aliases: Map<string, string>): string {
  return aliases.get(name) ?? name;
}

function pyTypeName(node: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (!node) return null;
  if (node.type === "identifier") return resolveAlias(node.text, aliases);
  if (node.type === "type") {
    const inner = node.namedChildren[0];
    return inner?.type === "identifier" ? resolveAlias(inner.text, aliases) : null;
  }
  return null;
}

function callTypeName(node: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (node?.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "identifier") return null;
  return aliases.get(fn.text) ?? fn.text;
}

function handlePy(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  const scopePath = scope.join(".");
  if (node.type === "typed_parameter") {
    const nameNode = node.namedChildren.find((c) => c.type === "identifier");
    const typeName = pyTypeName(node.childForFieldName("type"), aliases);
    if (nameNode && typeName) bindings.set(scopePath, nameNode.text, typeName);
    return;
  }
  if (node.type !== "assignment") return;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left) return;
  if (left.type === "identifier") {
    const typeField = node.childForFieldName("type");
    const typeName = typeField ? pyTypeName(typeField, aliases) : callTypeName(right, aliases);
    if (typeName) bindings.set(scopePath, left.text, typeName);
  } else if (left.type === "attribute") {
    const obj = left.childForFieldName("object");
    const attr = left.childForFieldName("attribute");
    if (obj?.type === "identifier" && (obj.text === "self" || obj.text === "cls") && attr) {
      const typeName = callTypeName(right, aliases);
      if (typeName) bindings.set(classScope ?? scopePath, `self.${attr.text}`, typeName);
    }
  }
}

function tsAnnotationTypeName(
  typeAnn: Parser.SyntaxNode | null | undefined,
  aliases: Map<string, string>,
): string | null {
  if (!typeAnn || typeAnn.type !== "type_annotation") return null;
  const t = typeAnn.namedChildren[0];
  return t?.type === "type_identifier" ? resolveAlias(t.text, aliases) : null;
}

function tsNewTypeName(value: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (value?.type !== "new_expression") return null;
  const ctor = value.childForFieldName("constructor");
  if (ctor?.type !== "identifier") return null;
  return aliases.get(ctor.text) ?? ctor.text;
}

function handleTs(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  const scopePath = scope.join(".");
  if (node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FN_VALUE_TYPES.has(value.type)) return; // a function def, not a type binding
    const name = node.childForFieldName("name");
    if (name?.type !== "identifier") return;
    const typeName = tsNewTypeName(value, aliases) ?? tsAnnotationTypeName(node.childForFieldName("type"), aliases);
    if (typeName) bindings.set(scopePath, name.text, typeName);
  } else if (node.type === "public_field_definition") {
    const name = node.childForFieldName("name");
    if (!name) return;
    const typeName =
      tsAnnotationTypeName(node.childForFieldName("type"), aliases) ??
      tsNewTypeName(node.childForFieldName("value"), aliases);
    if (typeName) bindings.set(classScope ?? scopePath, `this.${name.text}`, typeName);
  } else if (node.type === "required_parameter") {
    const pattern = node.childForFieldName("pattern");
    if (pattern?.type !== "identifier") return;
    const typeName = tsAnnotationTypeName(node.childForFieldName("type"), aliases);
    if (typeName) bindings.set(scopePath, pattern.text, typeName);
  }
}

function handleGo(node: Parser.SyntaxNode, scope: string[], bindings: FileBindings): void {
  const scopePath = scope.join(".");
  if (node.type === "var_spec") {
    const name = node.childForFieldName("name");
    let type = node.childForFieldName("type");
    if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
    if (name?.type === "identifier" && type?.type === "type_identifier") {
      bindings.set(scopePath, name.text, type.text);
    }
    return;
  }
  if (node.type !== "short_var_declaration") return;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || !right) return;
  const names = left.namedChildren;
  const exprs = right.namedChildren;
  for (let i = 0; i < names.length; i++) {
    const nameNode = names[i];
    let expr = exprs[i];
    if (!nameNode || nameNode.type !== "identifier" || !expr) continue;
    if (expr.type === "unary_expression") {
      expr = expr.namedChildren.find((c) => c.type === "composite_literal") ?? expr;
    }
    let typeName: string | null = null;
    if (expr.type === "composite_literal") {
      const t = expr.childForFieldName("type");
      typeName = t?.type === "type_identifier" ? t.text : null;
    } else if (expr.type === "call_expression") {
      const fn = expr.childForFieldName("function");
      // Go convention: NewX(...) binds to X.
      if (fn?.type === "identifier" && /^New[A-Z]/.test(fn.text)) typeName = fn.text.slice(3);
    }
    if (typeName) bindings.set(scopePath, nameNode.text, typeName);
  }
}

/** A `field_declaration`'s bare type name — `type_identifier`/`qualified_identifier`
 * text directly, or a `template_type`'s own `name` field (`std::vector<Foo>` binds
 * as `std::vector`, `Box<T>` as `Box`). `primitive_type` and other built-ins return
 * null (nothing useful to bind a receiver to). */
function cppFieldTypeName(typeField: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (!typeField) return null;
  if (typeField.type === "type_identifier" || typeField.type === "qualified_identifier") {
    return resolveAlias(typeField.text, aliases);
  }
  if (typeField.type === "template_type") {
    const name = typeField.childForFieldName("name");
    return name ? resolveAlias(name.text, aliases) : null;
  }
  return null;
}

/** Member-variable type bindings: a `field_declaration` whose declarator unwraps to a
 * bare `field_identifier` (a data member, not a method prototype — those unwrap to a
 * `function_declarator` and are skipped) binds `this.<field>` -> its type, the same
 * purpose C#'s `handleCSharp` field-type collection serves — so `this->member.method()`
 * / `member.method()` call sites can resolve a receiver type. */
function handleCpp(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  if (node.type !== "field_declaration") return;
  const declarator = unwrapCppDeclarator(node.childForFieldName("declarator"));
  if (declarator?.type !== "field_identifier") return;
  const typeName = cppFieldTypeName(node.childForFieldName("type"), aliases);
  if (typeName) bindings.set(classScope ?? scope.join("."), `this.${declarator.text}`, typeName);
}

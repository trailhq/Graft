; C# tags — minimal, matched to the tree-sitter-wasms c_sharp grammar node types.
; (Upstream tree-sitter-c-sharp tags.scm references node types the bundled wasm
;  grammar version lacks — "Bad node name 'type'" — so graft ships this instead.)

(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration (identifier) @name) @definition.class
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration (identifier) @name) @definition.method
(property_declaration name: (identifier) @name) @definition.variable
(namespace_declaration name: (identifier) @name) @definition.module

(invocation_expression
  function: [
    (identifier) @name
    (member_access_expression name: (identifier) @name)
  ]) @reference.call

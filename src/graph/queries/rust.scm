; Rust tags — standard tree-sitter tags convention (@definition.<kind> + @name + @reference.call).
; Vendored for graft's generic breadth tier. Predicates like (#strip! ...) are
; sanitized out at load time by generic.ts.

(function_item (identifier) @name) @definition.function

(function_signature_item (identifier) @name) @definition.function

(struct_item (type_identifier) @name) @definition.struct

(enum_item (type_identifier) @name) @definition.enum

(union_item (type_identifier) @name) @definition.struct

(trait_item (type_identifier) @name) @definition.interface

(type_item (type_identifier) @name) @definition.type

(mod_item (identifier) @name) @definition.module

(macro_definition (identifier) @name) @definition.function

(const_item (identifier) @name) @definition.constant

(static_item (identifier) @name) @definition.constant

; associated functions / methods inside impl blocks are function_item too,
; already captured above; call sites below:

(call_expression
  function: [
    (identifier) @name
    (field_expression field: (field_identifier) @name)
    (scoped_identifier name: (identifier) @name)
  ]) @reference.call

(macro_invocation
  macro: [
    (identifier) @name
    (scoped_identifier name: (identifier) @name)
  ]) @reference.call

; Depth-tier WASM fallback (#119). TSX grammar is TypeScript + JSX; reuse the
; TypeScript definition/call captures. Walker covers anything this misses.

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(class_declaration
  name: [(type_identifier) (identifier)] @name) @definition.class

(abstract_class_declaration
  name: [(type_identifier) (identifier)] @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: [(identifier) (type_identifier)] @name) @definition.enum

(method_definition
  name: (property_identifier) @name) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression) (generator_function)])) @definition.function

(call_expression
  function: [
    (identifier) @name
    (member_expression
      property: (property_identifier) @name)
  ]) @reference.call

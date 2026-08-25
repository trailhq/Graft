; Depth-tier WASM fallback (#119).

(function_declaration
  name: (identifier) @name) @definition.function

(method_declaration
  name: (field_identifier) @name) @definition.method

(type_spec
  name: (type_identifier) @name
  type: (struct_type)) @definition.struct

(type_spec
  name: (type_identifier) @name
  type: (interface_type)) @definition.interface

(type_spec
  name: (type_identifier) @name) @definition.type

(call_expression
  function: [
    (identifier) @name
    (selector_expression
      field: (field_identifier) @name)
  ]) @reference.call

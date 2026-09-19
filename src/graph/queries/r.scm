; Depth-tier WASM fallback (#119).

(binary_operator
  lhs: (identifier) @name
  operator: "<-"
  rhs: (function_definition)
) @definition.function

(binary_operator
  lhs: (identifier) @name
  operator: "="
  rhs: (function_definition)
) @definition.function

(call
  function: (identifier) @name
) @reference.call

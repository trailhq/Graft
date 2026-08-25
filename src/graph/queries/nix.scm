; Nix tags — standard tree-sitter tags convention (@definition.<kind> + @name + @reference.call).
; Based on upstream tree-sitter-nix queries, extended for graft's breadth tier.
;
; Note: `binding` inside `let_expression` cannot have its children matched in
; tree-sitter queries (parse error), so let-bound variables are NOT captured as
; @definition. They are still searchable via the file node's residual body.

; Function definitions: `name = args: body` or `name = body` (where body is a function)
(binding
  (attrpath (identifier) @name)
  (function_expression) @definition.function)

; Inherit statements: `inherit (source) name1 name2`
(inherit
  (inherited_attrs (identifier) @name @definition.constant))

; Function calls: `function arg` or `function arg1 arg2` (nested apply_expression)
; Matches e.g. `import ./path` when `import` is applied to arguments.
(apply_expression
  function: (apply_expression
    function: (variable_expression
      name: (identifier) @name))) @reference.call

; Method/attribute calls: `builtins.map`, `pkgs.python3.withPackages`, etc.
(apply_expression
  function: (select_expression
    attrpath: (attrpath attr: (identifier) @name))) @reference.call

; Direct function application: `f arg`
(apply_expression
  function: (variable_expression
    name: (identifier) @name)) @reference.call

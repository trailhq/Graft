; GDScript (Godot). Grammar: tree-sitter-gdscript (wasm bundle).
; A .gd file IS a class, so `class_name X` is the file's own definition and
; `class Inner:` is a nested one. Both surface as @definition.class.

(class_name_statement
  name: (name) @name) @definition.class

(class_definition
  name: (name) @name) @definition.class

; Methods: any func inside a `class Inner:` body.
(class_definition
  body: (class_body
    (function_definition
      name: (name) @name) @definition.method))

; Top-level funcs (a .gd file's own methods) and constructors.
(function_definition
  name: (name) @name) @definition.function

(constructor_definition) @definition.method

; Signals are the wiring of a Godot codebase — name them so `graft callers`
; finds every emit/connect site.
(signal_statement
  name: (name) @name) @definition.property

(enum_definition
  name: (name) @name) @definition.enum

; Class-level const/var only. A bare `(variable_statement)` would also match
; every local inside a function body — on a real Godot repo that is ~40k nodes
; of noise that buries the symbols an agent is actually looking for.
(source
  (const_statement
    name: (name) @name) @definition.constant)

(class_body
  (const_statement
    name: (name) @name) @definition.constant)

(source
  (variable_statement
    name: (name) @name) @definition.property)

(class_body
  (variable_statement
    name: (name) @name) @definition.property)

; Calls: bare `foo()` and receiver calls `node.foo()`.
(call
  (identifier) @name) @reference.call

(attribute_call
  (identifier) @name) @reference.call

; GDScript has no import statement — a script pulls in another script with
; `preload("res://...")` (compile time) or `load(...)` (runtime). Capturing the
; literal is what gives a .gd file incoming `imports` edges, and with them a
; blast radius: edit a script and graft can say who preloads it.
(call
  (identifier) @_fn
  arguments: (arguments
    . (string) @name)
  (#eq? @_fn "preload")) @reference.import

(call
  (identifier) @_fn
  arguments: (arguments
    . (string) @name)
  (#eq? @_fn "load")) @reference.import

; Method definitions

(
  (comment)* @doc
  .
  [
    (method
      name: (_) @name) @definition.method
    (singleton_method
      name: (_) @name) @definition.method
  ]
  (#strip! @doc "^#\\s*")
  (#select-adjacent! @doc @definition.method)
)

(alias
  name: (_) @name) @definition.method

(setter
  (identifier) @ignore)

; Class definitions

(
  (comment)* @doc
  .
  [
    (class
      name: [
        (constant) @name
        (scope_resolution
          name: (_) @name)
      ]) @definition.class
    (singleton_class
      value: [
        (constant) @name
        (scope_resolution
          name: (_) @name)
      ]) @definition.class
  ]
  (#strip! @doc "^#\\s*")
  (#select-adjacent! @doc @definition.class)
)

; Module definitions

(
  (module
    name: [
      (constant) @name
      (scope_resolution
        name: (_) @name)
    ]) @definition.module
)

; Calls
; NB: only explicit call nodes — the upstream tags.scm also tags bare
; [(identifier)(constant)] as @reference.call gated by (#is-not? local), but that
; predicate needs the paired @local.* captures (from locals.scm, which graft does
; not load) to mean anything. Without them it's a no-op, so bare *variable reads*
; that share a name with a same-file/unique method become bogus `calls` edges
; (resolve.ts can't tell a var read from a zero-arg call). Dropped for precision —
; consistent with every other breadth-tier query (all use explicit call nodes).

(call method: (identifier) @name) @reference.call

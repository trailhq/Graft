; Clojure's tree-sitter grammar has no dedicated node types for `defn`/`def`/etc
; — every form, definition or call alike, is just a `list_lit` whose `value`
; field lists its children positionally. So a "definition" here is a list whose
; first symbol is a known defining macro, matched by name via `#any-of?`/`#eq?`,
; with the second symbol captured as the defined name.

; Definitions

; * namespace
(list_lit
  .
  value: (sym_lit name: (sym_name) @ignore)
  .
  value: (sym_lit name: (sym_name) @name)
  (#eq? @ignore "ns")) @definition.module

; * functions/macros/multimethods
(list_lit
  .
  value: (sym_lit name: (sym_name) @ignore)
  .
  value: (sym_lit name: (sym_name) @name)
  (#any-of? @ignore "defn" "defn-" "defmacro" "defmulti" "defmethod" "definline" "deftest")) @definition.function

; * def / defonce — a Var binding, not necessarily a function
(list_lit
  .
  value: (sym_lit name: (sym_name) @ignore)
  .
  value: (sym_lit name: (sym_name) @name)
  (#any-of? @ignore "def" "defonce")) @definition.variable

; * defprotocol / definterface
(list_lit
  .
  value: (sym_lit name: (sym_name) @ignore)
  .
  value: (sym_lit name: (sym_name) @name)
  (#any-of? @ignore "defprotocol" "definterface")) @definition.interface

; * defrecord / deftype / defstruct — each mints a JVM class
(list_lit
  .
  value: (sym_lit name: (sym_name) @ignore)
  .
  value: (sym_lit name: (sym_name) @name)
  (#any-of? @ignore "defrecord" "deftype" "defstruct")) @definition.class

; References

; * function/macro call — any parenthesized list headed by a symbol. This also
; matches the def-forms above on their own keyword (e.g. `(defn foo …)` reads
; as a "call" to `defn`) and special forms (`let`, `if`, `fn`, …); those never
; resolve to an in-repo definition, so the existing resolver drops them rather
; than guessing — same trade-off the elixir/ruby queries make.
(list_lit
  .
  value: (sym_lit name: (sym_name) @name)) @reference.call

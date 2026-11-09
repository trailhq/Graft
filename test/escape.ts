// Escaping for strings a test builds into a regex or into generated code.

/** A string matched literally inside a RegExp. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A value as a JS literal that is safe to splice into generated source. */
export const jsLit = (v: unknown): string =>
  JSON.stringify(v).replace(/[<>\/\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

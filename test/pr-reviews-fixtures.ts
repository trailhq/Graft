/** GitHub's answer for a repo's merged PRs and their review threads, shared by the PR-review tests. */

export const human = (login: string) => ({ login, __typename: "User" });
export const bot = { login: "coderabbitai", __typename: "Bot" };

/** `answer` with each PR, comment, review and thread comment by a person marked as a member of the repo (GitHub's authorAssociation). */
function onTeam<T>(answer: T): T {
  const mark = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(mark);
    if (!v || typeof v !== "object") return v;
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "author" ? x : mark(x)]));
    const a = (v as { author?: { __typename?: string } }).author;
    return a && a.__typename !== "Bot" && !("authorAssociation" in o) ? { ...o, authorAssociation: "MEMBER" } : o;
  };
  return mark(answer) as T;
}

export const HUNK = "@@ -10,6 +10,8 @@ export async function orders(req) {\n   const rows = await db.query(sql);\n+  // TODO\n   return rows;";

/** GitHub's GraphQL answer for four merged PRs (one reviewed only by a bot) and one closed without merging; every person in it is on the team. */
export const GITHUB = onTeam({
  data: {
    repository: {
      closed: {
        nodes: [
          {
            number: 36,
            title: "Sessions in Redis",
            body: "Moves sessions to Redis so restarts keep people signed in, as discussed in the sessions thread last week.",
            closedAt: "2026-10-08T09:00:00Z",
            author: { login: "erin" },
            comments: { nodes: [{ body: "Closing: we decided to keep sessions in Postgres, one less thing to run.", author: human("alice") }] },
            reviews: { nodes: [] },
            reviewThreads: { nodes: [] },
          },
        ],
      },
      merged: {
        nodes: [
          {
            number: 38,
            title: "Users endpoint",
            mergedAt: "2026-10-05T09:00:00Z",
            author: { login: "bob" },
            reviews: { nodes: [{ body: "", author: human("alice") }] },
            reviewThreads: {
              nodes: [{ isOutdated: true, comments: { nodes: [{ body: "Same again: handlers in src/api must return a 500 when db.query fails.", path: "src/api/users.ts", author: human("alice") }] } }],
            },
          },
          {
            number: 41,
            title: "Orders endpoint",
            mergedAt: "2026-10-10T09:00:00Z",
            author: { login: "bob" },
            reviews: { nodes: [{ body: "Looks good once the error handling is in. <!-- review-bot:ignore -->", author: human("alice") }] },
            reviewThreads: {
              nodes: [
                {
                  isOutdated: true,
                  comments: {
                    nodes: [
                      { body: "This handler swallows the error from db.query, log it and return a 500.", path: "src/api/orders.ts", diffHunk: HUNK, author: human("alice") },
                      { body: "> This handler swallows the error\n\ndone, thanks", path: "src/api/orders.ts", author: human("bob") },
                    ],
                  },
                },
                { isResolved: true, comments: { nodes: [{ body: "Consider adding tests for this endpoint.", path: "src/api/orders.ts", author: bot }] } },
                // Nobody acted on it: not a rule.
                { isOutdated: false, isResolved: false, comments: { nodes: [{ body: "Nit: maybe rename rows to orders?", path: "src/api/orders.ts", author: human("alice") }] } },
              ],
            },
          },
          {
            number: 35,
            title: "Fixture refresh",
            mergedAt: "2026-09-30T09:00:00Z",
            author: { login: "carol" },
            reviews: { nodes: [{ body: "Thanks!", author: human("dan") }] },
            reviewThreads: {
              nodes: [{ isResolved: true, comments: { nodes: [{ body: "The fixture has token: ghp_abcdefghijklmnopqrstuvwxyz1234 in it, please add a changelog entry too.", path: "CHANGELOG.md", author: human("dan") }] } }],
            },
          },
          {
            number: 30,
            title: "Bump deps",
            mergedAt: "2026-09-20T09:00:00Z",
            author: { login: "dependabot", __typename: "Bot" },
            reviews: { nodes: [{ body: "Auto-approved.", author: { login: "github-actions[bot]" } }] },
            reviewThreads: { nodes: [] },
          },
        ],
      },
    },
  },
});

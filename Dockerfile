# The graft GitHub App.
#
# Runs anywhere that takes a container — a VM, Fly, Cloud Run, App Runner. It
# needs git on the PATH (it fetches pull request refs) and nothing else at
# runtime.
#
# Two constraints shape the stages, and both were found the hard way:
#
#  - `npm ci` runs this package's `prepare` script, which IS the build. So the
#    sources have to be present before the install, not after it — a manifests-
#    only copy fails with "The specified path does not exist: 'tsconfig.json'".
#  - The runtime cannot reinstall. `npm ci --omit=dev` would run `prepare` again
#    without tsc present, and `--ignore-scripts` would skip the native builds
#    tree-sitter needs. So the compiled node_modules is carried over from the
#    build stage and pruned in place.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci

FROM node:20-bookworm-slim
# git is a runtime dependency here, not a build one: the App fetches each pull
# request's merge ref.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# devDependencies are dead weight next to a process that clones code written by
# strangers. Pruning keeps the native bindings that were already compiled;
# --ignore-scripts stops `prepare` from trying to rebuild without tsc.
RUN npm prune --omit=dev --ignore-scripts && npm cache clean --force

# Never root: this process handles untrusted source and has no reason to be able
# to write outside its own tree.
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/app/main.js"]

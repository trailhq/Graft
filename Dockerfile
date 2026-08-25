# The graft GitHub App.
#
# Runs anywhere that takes a container — Fly, Cloud Run, ECS, a VM. It needs git
# on the PATH (it fetches pull request refs) and nothing else at runtime.
#
# The build stage keeps devDependencies out of the final image: this process
# clones code written by strangers, so the less that is installed next to it, the
# smaller the blast radius of anything that goes wrong.
FROM node:20-bookworm-slim AS build
WORKDIR /app
# scripts/ comes along because package.json runs scripts/postinstall.mjs on
# install. Copying only the manifests means node cannot find that file and exits
# 1 before the script's own "never fail an install" guard ever runs. Dropping to
# --ignore-scripts is not the way out: tree-sitter builds its native bindings in
# exactly those hooks.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim
# git is a runtime dependency here, not a build one.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Never root: the whole point of the checkout rules is that this process handles
# untrusted source, and it has no reason to be able to write outside its tree.
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/app/main.js"]

// Version this identifier when the recipe changes: it also namespaces build caches.
export const TOOLCHAIN_IMAGE = 'reroute:node-rust-v1';
export const TOOLCHAIN_BASE = 'rust:1-bookworm';
export const TOOLCHAIN_COMMANDS = [
  'COPY --from=node:22-bookworm /usr/local/bin/node /usr/local/bin/node',
  'COPY --from=node:22-bookworm /usr/local/lib/node_modules /usr/local/lib/node_modules',
  'RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && apt-get update && apt-get install -y --no-install-recommends python3 git rsync build-essential pkg-config ca-certificates && rm -rf /var/lib/apt/lists/*',
];

/**
 * The playground dev server.
 *
 * Bun bundles the HTML entry and its TypeScript for the browser, so the
 * playground needs no bundler, no framework, and no build step.
 */

import index from "../index.html";

const port = Number(Bun.env["PORT"] ?? 5273);

const server = Bun.serve({
  port,
  routes: { "/": index },
  development: true,
});

console.log(`Ranksta mascot playground → ${server.url}`);

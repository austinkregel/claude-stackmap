#!/usr/bin/env node
/**
 * End-to-end smoke test: starts the built server over stdio and exercises every tool,
 * including the failure paths. Run with `npm run smoke` after `npm run build`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");

const client = new Client({ name: "stackmap-smoke", version: "1" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));

let failures = 0;
const call = async (label, name, args, expectError = false) => {
  const r = await client.callTool({ name, arguments: args });
  const got = Boolean(r.isError);
  const ok = got === expectError;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${got ? " [isError]" : ""}`);
  console.log(r.content[0].text.slice(0, 700).replace(/^/gm, "      "));
  console.log();
};

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "), "\n");

await call("indexes", "stackmap_indexes", {});
await call("bindings filtered", "stackmap_bindings", { filter: "AppRepositoryProvider", limit: 2 });
await call("resolve known contract", "stackmap_resolve", {
  symbol: "App\\Contracts\\Services\\Domain\\CampaignSetupServiceContract",
});
await call("contextual bindings", "stackmap_bindings", { kind: "contextual", limit: 2 });
await call("declaration edges", "stackmap_bindings", { kind: "declaration", filter: "HasComparatorsContract", limit: 2 });
await call("resolve a computed-key singleton", "stackmap_resolve", { symbol: "App\\Filters\\InventoryFilter\\EqualFilter" });
await call("resolve unknown symbol", "stackmap_resolve", { symbol: "App\\Nope\\DoesNotExist" });
await call("unknown kind rejected", "stackmap_bindings", { kind: "nonsense" }, true);
await call("empty symbol rejected", "stackmap_resolve", { symbol: "" }, true);
await call("unknown index rejected", "stackmap_bindings", { index: "no-such-index" }, true);

await client.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

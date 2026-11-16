#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { FacetClient, type FacetType } from "./index.js";

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const controlApiUrl =
    process.env.FACET_CONTROL_API_URL ?? "http://127.0.0.1:4000";
  const client = new FacetClient({
    controlApiUrl,
    ...(process.env.FACET_GATEWAY_URL
      ? { gatewayUrl: process.env.FACET_GATEWAY_URL }
      : {}),
    ...(process.env.FACET_DEV_USER
      ? { devUser: process.env.FACET_DEV_USER }
      : {}),
    ...(process.env.FACET_BEARER_TOKEN
      ? { bearerToken: process.env.FACET_BEARER_TOKEN }
      : {}),
  });

  if (command === "search") {
    const query = rest[0] && !rest[0].startsWith("--") ? rest[0] : "";
    const type = argValue(rest, "--type") as FacetType | undefined;
    const category = argValue(rest, "--category");
    const facets = await client.searchFacets({ query, type, category });
    console.log(JSON.stringify({ facets }, null, 2));
    return;
  }

  if (command === "inspect" && rest[0]) {
    const facet = await client.getFacet(rest[0]);
    console.log(JSON.stringify({ facet }, null, 2));
    return;
  }

  if (command === "publish-actor") {
    const filePath = argValue(rest, "--file");
    if (!filePath) throw new Error("--file <actor-manifest.json> is required");
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Parameters<
      FacetClient["publishActor"]
    >[0];
    const facet = await client.publishActor(raw);
    console.log(JSON.stringify({ facet }, null, 2));
    return;
  }

  console.error(
    "Usage: facet <search [query] [--type HOSTED_ACTOR|AUTONOMOUS_AGENT|EXTERNAL_HTTP_API] | inspect <facetId> | publish-actor --file <json>>",
  );
  process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

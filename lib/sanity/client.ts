import { createClient } from "@sanity/client";
import type { Env } from "../../types/env";

/** Create a Sanity client bound to the worker environment. */
export function getSanityClient(env: Env) {
  return createClient({
    projectId: env.SANITY_PROJECT_ID,
    dataset: env.SANITY_DATASET,
    apiVersion: "2023-10-01",
    token: env.SANITY_SYNC_TOKEN,
    useCdn: false,
  });
}


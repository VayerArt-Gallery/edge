import type { Env } from "../../types/env";
import {
  syncMetafieldCollections,
  type MetafieldCollectionConfig,
} from "../../lib/shopify/collection-sync";

const ARTIST_COLLECTION_CONFIG: MetafieldCollectionConfig = {
  label: "artist",
  namespace: "custom",
  key: "artist",
  handlePrefix: "artist-",
  description: "artist",
  collectionMetafields: [
    {
      namespace: "custom",
      key: "type",
      value: "Artist",
      type: "single_line_text_field",
    },
  ],
  sortOrder: "ALPHA_ASC",
};

export function syncArtistCollections(env: Env): Promise<void> {
  return syncMetafieldCollections(env, ARTIST_COLLECTION_CONFIG);
}

import type { Env } from "../../types/env";
import {
  syncMetafieldCollections,
  type CollectionValue,
  type MetafieldCollectionConfig,
} from "../../lib/shopify/collection-sync";

const STYLE_COLLECTION_CONFIG: MetafieldCollectionConfig = {
  label: "style",
  namespace: "shopify",
  key: "art-movement",
  handlePrefix: "style-",
  description: "style",
  collectionMetafields: [
    {
      namespace: "custom",
      key: "type",
      value: "Style",
      type: "single_line_text_field",
    },
  ],
  sortOrder: "ALPHA_ASC",
  extractValues: (_raw, references) =>
    references
      .map<CollectionValue | null>((ref) => {
        const condition = ref.id?.trim();
        const title = ref.label?.value?.trim() || ref.handle?.trim();
        if (!condition || !title) return null;
        return { title, condition };
      })
      .filter((entry): entry is CollectionValue => entry !== null),
};

export function syncStyleCollections(env: Env): Promise<void> {
  return syncMetafieldCollections(env, STYLE_COLLECTION_CONFIG);
}

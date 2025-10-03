import type { Env } from "../../types/env";
import {
  syncMetafieldCollections,
  type MetafieldCollectionConfig,
} from "../../lib/shopify/collection-sync";

const THEME_COLLECTION_CONFIG: MetafieldCollectionConfig = {
  label: "theme",
  namespace: "shopify",
  key: "theme",
  handlePrefix: "theme-",
  description: "theme",
  collectionMetafields: [
    {
      namespace: "custom",
      key: "type",
      value: "Theme",
      type: "single_line_text_field",
    },
  ],
  sortOrder: "ALPHA_ASC",
  extractValues: (_raw, references) =>
    references.flatMap((ref) => {
      const condition = ref.id?.trim();
      const title = ref.label?.value?.trim() || ref.handle?.trim();
      return condition && title ? [{ title, condition }] : [];
    }),
};

export function syncThemeCollections(env: Env): Promise<void> {
  return syncMetafieldCollections(env, THEME_COLLECTION_CONFIG);
}


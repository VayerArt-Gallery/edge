import type { Env } from "../../types/env";
import type {
  CollectionCreateData,
  CollectionSummary,
  CollectionsQueryData,
  MetafieldDefinitionsData,
  ProductsQueryData,
  PublicationsQueryData,
  PublishablePublishData,
  ShopifyGraphqlResponse,
  ShopifyUserError,
} from "../../types/shopify-collections";
import { toSlug } from "../utils";

const PRODUCT_PAGE_SIZE = 250;
const COLLECTION_PAGE_SIZE = 250;
const SALES_CHANNEL_NAME = "React Storefront";

export type SortOrderConfigValue =
  | "MANUAL"
  | "BEST_SELLING"
  | "ALPHA_ASC"
  | "ALPHA_DESC"
  | "PRICE_ASC"
  | "PRICE_DESC"
  | "CREATED"
  | "CREATED_DESC";

export interface CollectionMetafieldInput {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface CollectionValue {
  /** Collection title and basis for handle slug. */
  title: string;
  /** Value used for the collection rule condition. */
  condition: string;
}

export interface MetafieldReferenceNode {
  id?: string;
  handle?: string;
  label?: { value?: string | null } | null;
}

export interface MetafieldCollectionConfig {
  label: string;
  namespace: string;
  key: string;
  handlePrefix: string;
  description: string;
  collectionMetafields?: CollectionMetafieldInput[];
  sortOrder?: SortOrderConfigValue;
  extractValues?: (
    value: string | null | undefined,
    references: MetafieldReferenceNode[],
  ) => CollectionValue[];
}

export async function syncMetafieldCollections(
  env: Env,
  config: MetafieldCollectionConfig,
): Promise<void> {
  const shopifyUrl = buildGraphqlUrl(env);

  const metafieldDefinitionId = await getMetafieldDefinitionId(
    shopifyUrl,
    env,
    config.namespace,
    config.key,
  );

  if (!metafieldDefinitionId) {
    console.error(
      `Could not find metafield definition for ${config.namespace}.${config.key}`,
    );
    return;
  }

  const entries = await fetchUniqueMetafieldEntries(shopifyUrl, env, config);
  console.log(`Found ${entries.length} unique ${config.label} values`);

  const existingCollections = await fetchExistingCollections(
    shopifyUrl,
    env,
    config.handlePrefix,
  );
  const existingHandles = new Set(
    existingCollections.map((collection) => collection.handle),
  );

  for (const entry of entries) {
    const handle = buildHandle(entry.title, config.handlePrefix);
    if (!handle) {
      console.warn(
        `Skipping ${config.label} "${entry.title}"; unable to build a valid collection handle`,
      );
      continue;
    }

    if (existingHandles.has(handle)) {
      console.log(
        `Collection already exists for ${config.label}: ${entry.title}`,
      );
      continue;
    }

    existingHandles.add(handle);
    await createCollection(
      shopifyUrl,
      env,
      entry,
      handle,
      metafieldDefinitionId,
      config,
    );
  }
}

async function createCollection(
  url: string,
  env: Env,
  entry: CollectionValue,
  handle: string,
  metafieldDefinitionId: string,
  config: MetafieldCollectionConfig,
): Promise<void> {
  const mutation = `
    mutation CreateCollection($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection {
          id
          title
          handle
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input: Record<string, unknown> = {
    title: entry.title,
    handle,
    descriptionHtml: config.description,
    ruleSet: {
      appliedDisjunctively: false,
      rules: [
        {
          column: "PRODUCT_METAFIELD_DEFINITION",
          relation: "EQUALS",
          condition: entry.condition,
          conditionObjectId: metafieldDefinitionId,
        },
      ],
    },
    metafields: config.collectionMetafields ?? [],
    ...(config.sortOrder && { sortOrder: config.sortOrder }),
  };

  try {
    const response = await shopifyRequest<CollectionCreateData>(
      url,
      env,
      mutation,
      {
        input,
      },
    );

    const result = response.data?.collectionCreate;
    if (!result) {
      console.error("Unexpected response:", JSON.stringify(response));
      return;
    }

    const userErrors = result.userErrors ?? [];
    if (userErrors.length > 0) {
      logUserErrors(
        `Errors creating collection for ${config.label} ${entry.title}`,
        userErrors,
      );
      return;
    }

    const created = result.collection;
    if (!created) {
      console.error(
        `Shopify did not return a collection for ${config.label} ${entry.title}`,
      );
      return;
    }

    console.log(`Created ${config.label} collection: ${created.title}`);
    await publishToSalesChannel(url, env, created.id, config.label);
  } catch (error) {
    console.error(
      `Failed to create collection for ${config.label} ${entry.title}:`,
      error,
    );
  }
}

async function fetchUniqueMetafieldEntries(
  url: string,
  env: Env,
  config: MetafieldCollectionConfig,
): Promise<CollectionValue[]> {
  const values = new Map<string, CollectionValue>();
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `
      query GetProducts($cursor: String) {
        products(first: ${PRODUCT_PAGE_SIZE}, after: $cursor) {
          edges {
            node {
              metafield(namespace: "${config.namespace}", key: "${config.key}") {
                value
                references(first: 10) {
                  nodes {
                    ... on Metaobject {
                      id
                      handle
                      label: field(key: "label") { value }
                    }
                  }
                }
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    const response: ShopifyGraphqlResponse<ProductsQueryData> =
      await shopifyRequest<ProductsQueryData>(url, env, query, {
        cursor,
      });

    const products = response.data?.products;
    if (!products) {
      throw new Error("Missing products data from Shopify response");
    }

    for (const edge of products.edges) {
      const metafield = edge.node.metafield;
      if (!metafield) continue;

      const references = (metafield.references?.nodes ?? []).filter(
        (node): node is MetafieldReferenceNode => Boolean(node),
      );

      const extracted = (config.extractValues ?? defaultExtractValues)(
        metafield.value,
        references,
      );

      for (const entry of extracted) {
        const title = entry.title?.trim();
        const condition = entry.condition?.trim();
        if (!title || !condition) continue;
        if (!values.has(condition)) {
          values.set(condition, { title, condition });
        }
      }
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.edges[products.edges.length - 1]?.cursor ?? null;
  }

  return Array.from(values.values());
}

async function fetchExistingCollections(
  url: string,
  env: Env,
  handlePrefix: string,
): Promise<CollectionSummary[]> {
  const collections: CollectionSummary[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `
      query GetCollections($cursor: String, $search: String!) {
        collections(first: ${COLLECTION_PAGE_SIZE}, after: $cursor, query: $search) {
          edges {
            node {
              id
              title
              handle
            }
            cursor
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    const response: ShopifyGraphqlResponse<CollectionsQueryData> =
      await shopifyRequest<CollectionsQueryData>(url, env, query, {
        cursor,
        search: buildCollectionSearchQuery(handlePrefix),
      });

    const collectionData = response.data?.collections;
    if (!collectionData) {
      throw new Error("Missing collections data from Shopify response");
    }

    for (const edge of collectionData.edges) {
      collections.push(edge.node);
    }

    hasNextPage = collectionData.pageInfo.hasNextPage;
    cursor =
      collectionData.edges[collectionData.edges.length - 1]?.cursor ?? null;
  }

  return collections;
}

async function shopifyRequest<T>(
  url: string,
  env: Env,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<ShopifyGraphqlResponse<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${text}`);
  }

  const json = (await response.json()) as ShopifyGraphqlResponse<T>;

  if (json.errors?.length) {
    console.error("GraphQL errors:", JSON.stringify(json.errors));
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json;
}

async function getMetafieldDefinitionId(
  url: string,
  env: Env,
  namespace: string,
  key: string,
): Promise<string | null> {
  const query = `
    query GetMetafieldDefinition {
      metafieldDefinitions(
        first: ${COLLECTION_PAGE_SIZE},
        ownerType: PRODUCT,
        namespace: "${namespace}",
        key: "${key}"
      ) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;

  const response = await shopifyRequest<MetafieldDefinitionsData>(
    url,
    env,
    query,
  );

  return response.data?.metafieldDefinitions.edges[0]?.node.id ?? null;
}

async function publishToSalesChannel(
  url: string,
  env: Env,
  collectionId: string,
  label: string,
): Promise<void> {
  const publicationsQuery = `
    {
      publications(first: 50) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `;

  const publicationsResponse: ShopifyGraphqlResponse<PublicationsQueryData> =
    await shopifyRequest<PublicationsQueryData>(url, env, publicationsQuery);

  const publicationEdge = publicationsResponse.data?.publications.edges.find(
    (edge) => edge.node.name === SALES_CHANNEL_NAME,
  );

  if (!publicationEdge) {
    console.error(`Sales channel '${SALES_CHANNEL_NAME}' not found`);
    return;
  }

  const publishMutation = `
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          availablePublicationsCount {
            count
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result: ShopifyGraphqlResponse<PublishablePublishData> =
    await shopifyRequest<PublishablePublishData>(url, env, publishMutation, {
      id: collectionId,
      input: [{ publicationId: publicationEdge.node.id }],
    });

  const userErrors = result.data?.publishablePublish?.userErrors ?? [];
  if (userErrors.length) {
    logUserErrors(
      `Errors publishing ${label} collection ${collectionId}`,
      userErrors,
    );
  }
}

function buildGraphqlUrl(env: Env): string {
  return `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
}

function logUserErrors(message: string, errors: ShopifyUserError[]): void {
  console.error(
    message,
    errors.map((error) => ({ field: error.field, message: error.message })),
  );
}

function buildHandle(value: string, prefix: string): string {
  const slug = toSlug(value);
  return slug ? `${prefix}${slug}` : "";
}

function buildCollectionSearchQuery(handlePrefix: string): string {
  return `handle:${handlePrefix}*`;
}

function defaultExtractValues(
  value: string | null | undefined,
): CollectionValue[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  return [{ title: trimmed, condition: trimmed }];
}

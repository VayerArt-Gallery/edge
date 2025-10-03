import type { Env } from "../../types/env";
import type {
  ArtistValue,
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
import { toSlug } from "../../lib/utils";

const ARTIST_METAFIELD_NAMESPACE = "custom";
const ARTIST_METAFIELD_KEY = "artist";
const ARTIST_COLLECTION_DESCRIPTION = "artist";
const PRODUCT_PAGE_SIZE = 250;
const COLLECTION_PAGE_SIZE = 250;
const SALES_CHANNEL_NAME = "React Storefront";
const COLLECTION_HANDLE_PREFIX = "artist-";

export async function syncArtistCollections(env: Env): Promise<void> {
  const shopifyUrl = buildGraphqlUrl(env);

  const metafieldDefId = await getMetafieldDefinitionId(shopifyUrl, env);
  if (!metafieldDefId) {
    console.error(
      `Could not find metafield definition for ${ARTIST_METAFIELD_NAMESPACE}.${ARTIST_METAFIELD_KEY}`,
    );
    return;
  }

  const artists = await fetchUniqueArtists(shopifyUrl, env);
  console.log(`Found ${artists.length} unique artists`);

  const existingCollections = await fetchExistingCollections(shopifyUrl, env);
  const existingHandles = new Set(
    existingCollections.map((collection) => collection.handle),
  );

  for (const artist of artists) {
    const handle = buildHandle(artist.value);
    if (!handle) {
      console.warn(
        `Skipping artist "${artist.value}"; unable to build a valid collection handle`,
      );
      continue;
    }

    if (existingHandles.has(handle)) {
      console.log(`Collection already exists: ${artist.value}`);
      continue;
    }

    existingHandles.add(handle);
    await createArtistCollection(shopifyUrl, env, artist.value, handle, metafieldDefId);
  }
}

async function createArtistCollection(
  url: string,
  env: Env,
  artistName: string,
  handle: string,
  metafieldDefinitionId: string,
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

  const input = {
    title: artistName,
    handle,
    descriptionHtml: ARTIST_COLLECTION_DESCRIPTION,
    ruleSet: {
      appliedDisjunctively: false,
      rules: [
        {
          column: "PRODUCT_METAFIELD_DEFINITION",
          relation: "EQUALS",
          condition: artistName,
          conditionObjectId: metafieldDefinitionId,
        },
      ],
    },
    metafields: [
      {
        namespace: ARTIST_METAFIELD_NAMESPACE,
        key: "type",
        value: "Artist",
        type: "single_line_text_field",
      },
    ],
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
      logUserErrors(`Errors creating collection for ${artistName}`, userErrors);
      return;
    }

    if (!result.collection) {
      console.error(`Shopify did not return a collection for ${artistName}`);
      return;
    }

    console.log(`Created collection: ${result.collection.title}`);
    await publishToSalesChannel(url, env, result.collection.id);
  } catch (error) {
    console.error(`Failed to create collection for ${artistName}:`, error);
  }
}

async function fetchUniqueArtists(
  url: string,
  env: Env,
): Promise<ArtistValue[]> {
  const artists = new Set<string>();
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `
      query GetProducts($cursor: String) {
        products(first: ${PRODUCT_PAGE_SIZE}, after: $cursor) {
          edges {
            node {
              metafield(namespace: "${ARTIST_METAFIELD_NAMESPACE}", key: "${ARTIST_METAFIELD_KEY}") {
                value
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
      const artistValue = edge.node.metafield?.value;
      if (artistValue) {
        artists.add(artistValue);
      }
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.edges[products.edges.length - 1]?.cursor ?? null;
  }

  return Array.from(artists).map((value) => ({ value }));
}

async function fetchExistingCollections(
  url: string,
  env: Env,
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
        search: buildCollectionSearchQuery(),
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
): Promise<string | null> {
  const query = `
    query GetMetafieldDefinition {
      metafieldDefinitions(
        first: ${COLLECTION_PAGE_SIZE},
        ownerType: PRODUCT,
        namespace: "${ARTIST_METAFIELD_NAMESPACE}",
        key: "${ARTIST_METAFIELD_KEY}"
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
  const edges = response.data?.metafieldDefinitions.edges ?? [];
  const firstEdge = edges[0];
  return firstEdge?.node.id ?? null;
}

async function publishToSalesChannel(
  url: string,
  env: Env,
  collectionId: string,
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
    logUserErrors(`Errors publishing collection ${collectionId}`, userErrors);
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

function buildHandle(artistName: string): string {
  const slug = toSlug(artistName);
  return slug ? `${COLLECTION_HANDLE_PREFIX}${slug}` : "";
}

function buildCollectionSearchQuery(): string {
  return `handle:${COLLECTION_HANDLE_PREFIX}*`;
}

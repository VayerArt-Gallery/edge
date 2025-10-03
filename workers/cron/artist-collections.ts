interface Env {
  SHOPIFY_ADMIN_API_TOKEN: string;
  SHOPIFY_STORE_DOMAIN: string;
  SHOPIFY_API_VERSION: string;
}

interface Artist {
  value: string;
}

interface Collection {
  id: string;
  title: string;
}

interface ShopifyResponse {
  data?: any;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: Record<string, any>;
  }>;
}

export async function syncArtistCollections(env: Env): Promise<void> {
  const shopifyUrl = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;

  const metafieldDefId = await getMetafieldDefinitionId(shopifyUrl, env);
  if (!metafieldDefId) {
    console.error("Could not find metafield definition for custom.artist");
    return;
  }

  const artists = await fetchUniqueArtists(shopifyUrl, env);
  console.log(`Found ${artists.length} unique artists`);

  const existingCollections = await fetchExistingCollections(shopifyUrl, env);
  const existingTitles = new Set(existingCollections.map((c) => c.title));

  for (const artist of artists) {
    if (!existingTitles.has(artist.value)) {
      await createArtistCollection(
        shopifyUrl,
        env,
        artist.value,
        metafieldDefId,
      );
    } else {
      console.log(`Collection already exists: ${artist.value}`);
    }
  }
}

async function createArtistCollection(
  url: string,
  env: Env,
  artistName: string,
  metafieldDefId: string,
): Promise<void> {
  const mutation = `
    mutation CreateCollection($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection {
          id
          title
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
    descriptionHtml: "artist",
    ruleSet: {
      appliedDisjunctively: false,
      rules: [
        {
          column: "PRODUCT_METAFIELD_DEFINITION",
          relation: "EQUALS",
          condition: artistName,
          conditionObjectId: metafieldDefId,
        },
      ],
    },
    metafields: [
      {
        namespace: "custom",
        key: "type",
        value: "Artist",
        type: "single_line_text_field",
      },
    ],
  };

  try {
    const response = await shopifyRequest(url, env, mutation, { input });

    if (!response.data?.collectionCreate) {
      console.error("Unexpected response:", JSON.stringify(response));
      return;
    }

    const { userErrors, collection } = response.data.collectionCreate;

    if (userErrors.length > 0) {
      console.error(
        `Errors creating collection for ${artistName}:`,
        userErrors,
      );
      return;
    }

    console.log(`Created collection: ${collection.title}`);

    // Publish to sales channel
    await publishToSalesChannel(url, env, collection.id);
  } catch (error) {
    console.error(`Failed to create collection for ${artistName}:`, error);
  }

  // try {
  //   const response = await shopifyRequest(url, env, mutation, { input });

  //   if (!response.data?.collectionCreate) {
  //     console.error("Unexpected response:", JSON.stringify(response));
  //     return;
  //   }

  //   const { userErrors, collection } = response.data.collectionCreate;

  //   if (userErrors.length > 0) {
  //     console.error(
  //       `Errors creating collection for ${artistName}:`,
  //       userErrors,
  //     );
  //     return;
  //   }

  //   console.log(`Created collection: ${collection.title}`);
  // } catch (error) {
  //   console.error(`Failed to create collection for ${artistName}:`, error);
  // }
}

async function fetchUniqueArtists(url: string, env: Env): Promise<Artist[]> {
  const artists = new Set<string>();
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `
      query GetProducts($cursor: String) {
        products(first: 250, after: $cursor) {
          edges {
            node {
              metafield(namespace: "custom", key: "artist") {
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

    const response = await shopifyRequest(url, env, query, {
      cursor,
    });
    const products = response.data.products;

    products.edges.forEach((edge: any) => {
      const artist = edge.node.metafield?.value;
      if (artist) {
        artists.add(artist);
      }
    });

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.edges[products.edges.length - 1]?.cursor || null;
  }

  return Array.from(artists).map((value) => ({ value }));
}

async function fetchExistingCollections(
  url: string,
  env: Env,
): Promise<Collection[]> {
  const collections: Collection[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const query = `
      query GetCollections($cursor: String) {
        collections(first: 250, after: $cursor) {
          edges {
            node {
              id
              title
            }
            cursor
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    const response = await shopifyRequest(url, env, query, {
      cursor,
    });
    const collectionData = response.data.collections;

    collections.push(
      ...collectionData.edges.map((edge: any) => ({
        id: edge.node.id,
        title: edge.node.title,
      })),
    );

    hasNextPage = collectionData.pageInfo.hasNextPage;
    cursor =
      collectionData.edges[collectionData.edges.length - 1]?.cursor || null;
  }

  return collections;
}

async function shopifyRequest(
  url: string,
  env: Env,
  query: string,
  variables: Record<string, any> = {},
): Promise<any> {
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

  const json: ShopifyResponse = await response.json();

  if (json.errors) {
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
    query {
      metafieldDefinitions(
        first: 250,
        ownerType: PRODUCT,
        namespace: "custom",
        key: "artist"
      ) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;

  const response = await shopifyRequest(url, env, query);
  const edges = response.data.metafieldDefinitions.edges;

  return edges.length > 0 ? edges[0].node.id : null;
}

async function publishToSalesChannel(
  url: string,
  env: Env,
  collectionId: string,
): Promise<void> {
  const channelQuery = `
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

  const channelResponse = await shopifyRequest(url, env, channelQuery);
  const publication = channelResponse.data.publications.edges.find(
    (edge: any) => edge.node.name === "React Storefront",
  );

  if (!publication) {
    console.error("Sales channel 'React Storefront' not found");
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

  await shopifyRequest(url, env, publishMutation, {
    id: collectionId,
    input: [{ publicationId: publication.node.id }],
  });
}

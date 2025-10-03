export interface CollectionSummary {
  id: string;
  title: string;
  handle: string;
}

export interface ShopifyGraphqlError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
  extensions?: Record<string, unknown>;
}

export interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: ShopifyGraphqlError[];
}

export interface ProductsQueryData {
  products: {
    edges: Array<{
      cursor: string;
      node: {
        metafield?: {
          value?: string | null;
          references?: {
            nodes?: Array<{
              id?: string;
              handle?: string;
              label?: { value?: string | null } | null;
            } | null>;
          } | null;
        } | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean };
  };
}

export interface CollectionsQueryData {
  collections: {
    edges: Array<{
      cursor: string;
      node: CollectionSummary;
    }>;
    pageInfo: { hasNextPage: boolean };
  };
}

export interface CollectionCreateData {
  collectionCreate: {
    collection: CollectionSummary | null;
    userErrors: ShopifyUserError[];
  };
}

export interface MetafieldDefinitionsData {
  metafieldDefinitions: {
    edges: Array<{
      node: { id: string };
    }>;
  };
}

export interface PublicationsQueryData {
  publications: {
    edges: Array<{
      node: { id: string; name: string };
    }>;
  };
}

export interface PublishablePublishData {
  publishablePublish: {
    publishable: {
      availablePublicationsCount: { count: number };
    } | null;
    userErrors: ShopifyUserError[];
  };
}

export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
}

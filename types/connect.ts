// ---- Types for Connect payloads -------------------------------------------

export type ConnectAction = "create" | "update" | "sync" | "delete";

export type ConnectProduct = {
  id: `gid://shopify/Product/${string}`;
  title: string;
  handle: string;
  descriptionHtml?: string;
  featuredImage?: { src: string } | null;
  options?: { name: string; position: number; values: string[] }[];
  priceRange?: { minVariantPrice?: number; maxVariantPrice?: number };
  productType?: string;
  tags?: string[];
  variants?: {
    id: `gid://shopify/ProductVariant/${string}`;
    title: string;
    compareAtPrice?: number;
    inventoryPolicy?: string;
    inventoryQuantity?: number;
    inventoryManagement?: string;
    image?: { src: string } | null;
    price?: string | number;
    product: {
      id: `gid://shopify/Product/${string}`;
      status: "active" | "archived" | "draft" | "unknown";
    };
    // Connect payloads sometimes use "value" (singular). We guard downstream.
    selectedOptions?: { name: string; values?: string; value?: string }[];
    sku?: string;
  }[];
  vendor?: string;
  status: "active" | "archived" | "draft" | "unknown";
  createdAt: string;
  publishedAt?: string;
  updatedAt: string;
};

export type PayloadProductsSync = {
  action: "create" | "update" | "sync";
  products: ConnectProduct[];
};
export type PayloadProductsDelete = { action: "delete"; productIds: number[] };
export type ConnectPayload = PayloadProductsSync | PayloadProductsDelete;

// ---- Type guards -----------------------------------------------------------

export const isProductSync = (p: ConnectPayload): p is PayloadProductsSync =>
  "products" in p &&
  (p.action === "create" || p.action === "update" || p.action === "sync");

export const isProductDelete = (
  p: ConnectPayload,
): p is PayloadProductsDelete => "productIds" in p && Array.isArray(p.productIds) && p.action === "delete";

import type { ConnectProduct } from "../../types/connect";
import { extractNumericId, stableKeyFrom } from "../utils";

export interface ProductDocWithEnrichment {
  _id: string;
  _type: "product";
  // We don't need strong typing for `store` here because we pass it through
  // as-is to patches; keep it flexible and focused on fields we enrich.
  store: Record<string, unknown>;
  artistName?: string;
  artist?: { _type: "reference"; _ref: string; _weak?: true };
  artMovement?: string;
  theme?: string;
  medium?: string;
  dimensionsMetric?: string;
  dimensionsImperial?: string;
}

/** Build the published product document skeleton to upsert into Sanity. */
export function buildStoreProductDocument(p: ConnectProduct): ProductDocWithEnrichment {
  const pid = extractNumericId(p.id);
  if (pid == null) throw new Error(`Bad product GID: ${p.id}`);

  return {
    _id: `shopifyProduct-${pid}`,
    _type: "product",
    store: {
      id: pid,
      gid: p.id,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      isDeleted: false,
      descriptionHtml: p.descriptionHtml ?? "",
      previewImageUrl: p.featuredImage?.src ?? "",
      priceRange: {
        minVariantPrice:
          p.priceRange?.minVariantPrice !== undefined
            ? p.priceRange.minVariantPrice
            : undefined,
        maxVariantPrice:
          p.priceRange?.maxVariantPrice !== undefined
            ? p.priceRange.maxVariantPrice
            : undefined,
      },
      productType: p.productType ?? "",
      slug: { _type: "slug", current: p.handle },
      status: p.status,
      tags: Array.isArray(p.tags) ? p.tags : [],
      title: p.title,
      vendor: p.vendor ?? "",
      options: (p.options ?? []).map((o) => ({
        _key: stableKeyFrom(o.name || String(o.position ?? "")),
        _type: "option",
        name: o.name,
        values: Array.isArray(o.values) ? o.values : [],
      })),
      variants: (p.variants ?? []).map((v) => ({
        _type: "reference",
        _ref: `shopifyProductVariant-${extractNumericId(v.id)}`,
        _weak: true,
        _key: String(extractNumericId(v.id) ?? ""),
      })),
    },
  };
}

/**
 * Build product variant documents derived from a Shopify product.
 * Computes availability semantics in a way that tolerates untracked inventory.
 */
export function buildVariantDocs(p: ConnectProduct) {
  const pid = extractNumericId(p.id)!;
  return (p.variants ?? []).map((v) => {
    const vid = extractNumericId(v.id);
    if (vid == null) throw new Error(`Bad variant GID: ${v.id}`);

    const qty = Number(v.inventoryQuantity ?? 0);
    const policy = (v.inventoryPolicy ?? "DENY").toUpperCase();
    const management = (v.inventoryManagement ?? "").toUpperCase();
    const productStatus = v.product?.status ?? p.status ?? "unknown";

    const isAvailable =
      productStatus === "active" && (management ? policy === "CONTINUE" || qty > 0 : true);

    const opts = (v.selectedOptions ?? []).map((o) => o.values ?? o.value ?? "");
    const [option1, option2, option3] = [opts[0] ?? "", opts[1] ?? "", opts[2] ?? ""];

    return {
      _id: `shopifyProductVariant-${vid}`,
      _type: "productVariant",
      store: {
        id: vid,
        gid: v.id,
        createdAt: p.createdAt,
        productId: pid,
        productGid: p.id,
        title: v.title,
        price: Number(v.price ?? 0),
        compareAtPrice: v.compareAtPrice !== undefined ? Number(v.compareAtPrice) : 0,
        previewImageUrl: v.image?.src ?? "",
        sku: v.sku ?? "",
        status: productStatus,
        inventory: {
          isAvailable,
          management: management || "",
          policy: policy || "DENY",
          quantity: qty,
        },
        option1,
        option2,
        option3,
      },
    };
  });
}

/** Build the product patch body (shared between published and draft ids). */
export function buildProductPatch(baseDoc: ProductDocWithEnrichment) {
  const body: Record<string, unknown> = { store: baseDoc.store };
  if (baseDoc.artistName) body["artistName"] = baseDoc.artistName;
  if (baseDoc.artist) body["artist"] = baseDoc.artist;
  if (baseDoc.artMovement) body["artMovement"] = baseDoc.artMovement;
  if (baseDoc.theme) body["theme"] = baseDoc.theme;
  if (baseDoc.medium) body["medium"] = baseDoc.medium;
  if (baseDoc.dimensionsMetric) body["dimensionsMetric"] = baseDoc.dimensionsMetric;
  if (baseDoc.dimensionsImperial)
    body["dimensionsImperial"] = baseDoc.dimensionsImperial;
  return body;
}

import type { ConnectProduct } from "../../types/connect";
import { extractNumericId, stableKeyFrom } from "../utils";

/** Build the published product document skeleton to upsert into Sanity. */
export function buildStoreProductDocument(p: ConnectProduct) {
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
export function buildProductPatch(
  baseDoc: ReturnType<typeof buildStoreProductDocument>,
) {
  const body: Record<string, unknown> = { store: baseDoc.store };
  if ((baseDoc as any).artistName)
    body["artistName"] = (baseDoc as any).artistName;
  if ((baseDoc as any).artist) body["artist"] = (baseDoc as any).artist;
  return body;
}


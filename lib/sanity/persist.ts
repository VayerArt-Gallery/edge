import type { Env } from "../../types/env";
import type { ConnectProduct } from "../../types/connect";
import { getSanityClient } from "./client";
import { buildProductPatch, buildStoreProductDocument, buildVariantDocs } from "./builders";
import { numericId14FromString, toSlug, extractNumericId } from "../utils";

/**
 * Upsert a single product and its variants into Sanity.
 * - Creates/patches published and existing draft product docs
 * - Ensures a stable artist reference
 * - Soft-deletes variants that no longer exist for this product
 */
export async function commitUpsertsForProduct(
  env: Env,
  product: ConnectProduct,
  artistNameById: Map<number, string>,
  ensuredArtistIds: Set<string>,
) {
  const sanity = getSanityClient(env);
  const tx = sanity.transaction();

  const pid = extractNumericId(product.id)!;
  const baseDoc = buildStoreProductDocument(product);

  // ----- Artist enrichment (optional) -----
  const artistName = artistNameById.get(pid);
  if (artistName) {
    const slug = toSlug(artistName);
    const artistPubId = `artist-${numericId14FromString(artistName)}`;
    (baseDoc as any).artistName = artistName;
    if (!ensuredArtistIds.has(artistPubId)) {
      tx.createIfNotExists({
        _id: artistPubId,
        _type: "artist",
        name: artistName,
        slug: { _type: "slug", current: slug },
      });
      ensuredArtistIds.add(artistPubId);
    }
    (baseDoc as any).artist = {
      _type: "reference",
      _ref: artistPubId,
      _weak: true,
    };
  }

  // ----- Product (published) -----
  tx.createIfNotExists({ _id: baseDoc._id, _type: baseDoc._type });
  tx.patch(baseDoc._id, (p) => p.set(buildProductPatch(baseDoc)));

  // ----- Product (draft) if exists -----
  const draftId = `drafts.${baseDoc._id}`;
  const hasDraft: string[] = await sanity.fetch(`*[_id==$id]._id`, { id: draftId });
  if (hasDraft.length) {
    tx.patch(draftId, (p) => p.set(buildProductPatch(baseDoc)));
  }

  // ----- Variants (published) -----
  const variantDocs = buildVariantDocs(product);
  for (const v of variantDocs) {
    tx.createIfNotExists({ _id: v._id, _type: v._type });
    tx.patch(v._id, (p) => p.set({ store: v.store }));
  }

  // Soft-delete variants that no longer exist for this product
  const currentIds = new Set(variantDocs.map((v) => Number(String(v.store.id))));
  const existingVariantIds: { _id: string; id: number }[] = await sanity.fetch(
    `*[_type=="productVariant" && store.productId==$pid]{_id, "id": store.id}`,
    { pid },
  );
  const missing = existingVariantIds.filter((e) => !currentIds.has(e.id));
  for (const m of missing) tx.patch(m._id, (p) => p.set({ "store.isDeleted": true }));

  await tx.commit();
}

/** Mark products (and their variants) as deleted (soft-delete). */
export async function markProductsDeleted(env: Env, productIds: number[]) {
  if (!productIds.length) return;
  const sanity = getSanityClient(env);
  const ids = productIds.map((n) => `shopifyProduct-${n}`);
  const drafts = ids.map((id) => `drafts.${id}`);
  const existing: string[] = await sanity.fetch(`*[_id in $ids]._id`, { ids });
  const existingDrafts: string[] = await sanity.fetch(`*[_id in $ids]._id`, { ids: drafts });
  const variantIds: string[] = await sanity.fetch(
    `*[_type=="productVariant" && store.productId in $pids]._id`,
    { pids: productIds },
  );
  if (!existing.length && !existingDrafts.length && !variantIds.length) return;
  const tx = sanity.transaction();
  for (const id of existing) tx.patch(id, (p) => p.set({ "store.isDeleted": true }));
  for (const id of existingDrafts) tx.patch(id, (p) => p.set({ "store.isDeleted": true }));
  for (const vid of variantIds) tx.patch(vid, (p) => p.set({ "store.isDeleted": true }));
  await tx.commit();
}


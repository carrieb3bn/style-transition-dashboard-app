const { shopifyGraphQL, extractPrefixedTag } = require("../lib/shopify");

const SHOP_QUERY = `
  query ShopDomain {
    shop {
      primaryDomain {
        url
      }
      myshopifyDomain
    }
  }
`;

const PRODUCTS_QUERY = `
  query TransitionProducts($cursor: String) {
    products(
      first: 100
      after: $cursor
      query: "tag:'source:vendor' OR tag:'source:manufacturing'"
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          status
          totalInventory
          createdAt
          tags
          media(first: 1) {
            edges {
              node {
                ... on MediaImage {
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

function numericIdFromGid(gid) {
  // "gid://shopify/Product/1234567890" -> "1234567890"
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

async function fetchAllTransitionProducts() {
  let cursor = null;
  let hasNextPage = true;
  const products = [];

  while (hasNextPage) {
    const data = await shopifyGraphQL(PRODUCTS_QUERY, { cursor });
    const { edges, pageInfo } = data.products;

    for (const edge of edges) {
      products.push(edge.node);
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return products;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET" });
    return;
  }

  try {
    const [shopData, products] = await Promise.all([
      shopifyGraphQL(SHOP_QUERY),
      fetchAllTransitionProducts(),
    ]);

    const storeUrl = shopData.shop.primaryDomain.url; // e.g. https://threebirdnest.com
    const adminHandle = shopData.shop.myshopifyDomain.replace(".myshopify.com", ""); // e.g. three-bird-nest

    // Group by the value of the "style:" tag
    const groups = {};

    for (const product of products) {
      const styleKey = extractPrefixedTag(product.tags, "style");
      const source = product.tags.some((t) => t.toLowerCase() === "source:vendor")
        ? "vendor"
        : product.tags.some((t) => t.toLowerCase() === "source:manufacturing")
        ? "manufacturing"
        : "unknown";

      if (!styleKey) {
        // Skip products missing the shared style tag - can't be paired
        continue;
      }

      if (!groups[styleKey]) {
        groups[styleKey] = { styleKey, vendor: null, manufacturing: null, extras: [] };
      }

      const firstMediaEdge = product.media.edges[0];
      const image = firstMediaEdge && firstMediaEdge.node.image ? firstMediaEdge.node.image.url : null;

      const entry = {
        id: product.id,
        numericId: numericIdFromGid(product.id),
        title: product.title,
        handle: product.handle,
        status: product.status,
        totalInventory: product.totalInventory,
        createdAt: product.createdAt,
        image,
        url: `${storeUrl}/products/${product.handle}`,
        adminUrl: `https://admin.shopify.com/store/${adminHandle}/products/${numericIdFromGid(product.id)}`,
      };

      if (source === "vendor" && !groups[styleKey].vendor) {
        groups[styleKey].vendor = entry;
      } else if (source === "manufacturing" && !groups[styleKey].manufacturing) {
        groups[styleKey].manufacturing = entry;
      } else {
        groups[styleKey].extras.push(Object.assign({}, entry, { source }));
      }
    }

    const pairs = Object.values(groups).sort((a, b) =>
      a.styleKey.localeCompare(b.styleKey)
    );

    res.status(200).json({ pairs, totalProductsScanned: products.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

const { shopifyGraphQL, extractPrefixedTag } = require("../lib/shopify");

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
          tags
          featuredImage {
            url
          }
        }
      }
    }
  }
`;

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
    const products = await fetchAllTransitionProducts();

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

      const entry = {
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        totalInventory: product.totalInventory,
        image: product.featuredImage ? product.featuredImage.url : null,
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

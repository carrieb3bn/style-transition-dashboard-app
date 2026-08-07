const { shopifyGraphQL } = require("../lib/shopify");

const ORDERS_QUERY = `
  query SalesInRange($cursor: String, $searchQuery: String!) {
    orders(first: 100, after: $cursor, query: $searchQuery) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          lineItems(first: 50) {
            edges {
              node {
                quantity
                sku
                discountedTotalSet {
                  shopMoney {
                    amount
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

// Safety valves so a huge date range can't blow past the serverless timeout
const MAX_PAGES = 60; // 60 * 100 orders = 6,000 orders max per request
const MAX_MS = 50000; // bail with partial data before Vercel's ~60s limit

// Vercel's Node functions don't auto-parse JSON bodies outside a framework
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  let body;
  try {
    body = req.body && Object.keys(req.body).length ? req.body : await readJsonBody(req);
  } catch (err) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const { skus, startDate, endDate } = body || {};

  if (!Array.isArray(skus) || skus.length === 0) {
    res.status(400).json({ error: "skus array is required" });
    return;
  }
  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate are required (YYYY-MM-DD)" });
    return;
  }

  const skuSet = new Set(skus);
  const searchQuery = `created_at:>=${startDate} created_at:<=${endDate}`;

  // Per-SKU accumulators. orderIds is an array (not a Set) so it survives
  // JSON serialization back to the client, which unions them per-product.
  const totals = {};
  for (const sku of skus) {
    totals[sku] = { units: 0, revenue: 0, orderIdSet: new Set() };
  }

  let cursor = null;
  let hasNextPage = true;
  let page = 0;
  let ordersScanned = 0;
  const startTime = Date.now();
  let partial = false;

  try {
    while (hasNextPage) {
      if (page >= MAX_PAGES || Date.now() - startTime > MAX_MS) {
        partial = true;
        break;
      }

      const data = await shopifyGraphQL(ORDERS_QUERY, { cursor, searchQuery });
      const { edges, pageInfo } = data.orders;

      for (const { node: order } of edges) {
        ordersScanned += 1;
        for (const { node: li } of order.lineItems.edges) {
          const sku = li.sku;
          if (!sku || !skuSet.has(sku)) continue;

          totals[sku].units += li.quantity;
          totals[sku].revenue += parseFloat(li.discountedTotalSet.shopMoney.amount);
          totals[sku].orderIdSet.add(order.id);
        }
      }

      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
      page += 1;
    }

    const result = {};
    for (const sku of skus) {
      const t = totals[sku];
      const orderIds = Array.from(t.orderIdSet);
      const orderCount = orderIds.length;
      result[sku] = {
        units: t.units,
        revenue: Math.round(t.revenue * 100) / 100,
        orderIds,
        orderCount,
        aov: orderCount > 0 ? Math.round((t.revenue / orderCount) * 100) / 100 : 0,
      };
    }

    res.status(200).json({
      sales: result,
      ordersScanned,
      partial,
      dateRange: { startDate, endDate },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

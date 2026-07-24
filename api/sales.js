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
                discountedTotalSet {
                  shopMoney {
                    amount
                  }
                }
                product {
                  id
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

  const { productIds, startDate, endDate } = body || {};

  if (!Array.isArray(productIds) || productIds.length === 0) {
    res.status(400).json({ error: "productIds array is required" });
    return;
  }
  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate are required (YYYY-MM-DD)" });
    return;
  }

  const idSet = new Set(productIds);
  const searchQuery = `created_at:>=${startDate} created_at:<=${endDate}`;

  const totals = {};
  for (const id of productIds) {
    totals[id] = { units: 0, revenue: 0, orderIds: new Set() };
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
          const pid = li.product && li.product.id;
          if (!pid || !idSet.has(pid)) continue;

          totals[pid].units += li.quantity;
          totals[pid].revenue += parseFloat(li.discountedTotalSet.shopMoney.amount);
          totals[pid].orderIds.add(order.id);
        }
      }

      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
      page += 1;
    }

    const result = {};
    for (const id of productIds) {
      const t = totals[id];
      const orderCount = t.orderIds.size;
      result[id] = {
        units: t.units,
        revenue: Math.round(t.revenue * 100) / 100,
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

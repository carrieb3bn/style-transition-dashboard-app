const { shopifyGraphQL } = require("../lib/shopify");

// Refunds aren't filterable by date directly at the top level of the Admin
// API - they're nested under orders. To catch refunds processed after an
// order's original purchase date, we query by order UPDATED_AT (not
// created_at) across the range, then keep only refunds whose own createdAt
// falls inside the requested window.
const ORDERS_WITH_REFUNDS_QUERY = `
  query ReturnsInRange($cursor: String, $searchQuery: String!) {
    orders(first: 100, after: $cursor, query: $searchQuery) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          refunds {
            createdAt
            refundLineItems(first: 50) {
              edges {
                node {
                  quantity
                  lineItem {
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
    }
  }
`;

const MAX_PAGES = 60;
const MAX_MS = 50000;

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
  const searchQuery = `updated_at:>=${startDate} updated_at:<=${endDate}`;
  const rangeStart = new Date(startDate).getTime();
  // Add a day so endDate is inclusive through 23:59:59
  const rangeEnd = new Date(endDate).getTime() + 24 * 60 * 60 * 1000;

  const totals = {};
  for (const id of productIds) {
    totals[id] = { returnedUnits: 0 };
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

      const data = await shopifyGraphQL(ORDERS_WITH_REFUNDS_QUERY, { cursor, searchQuery });
      const { edges, pageInfo } = data.orders;

      for (const { node: order } of edges) {
        ordersScanned += 1;
        for (const refund of order.refunds) {
          const refundedAt = new Date(refund.createdAt).getTime();
          if (refundedAt < rangeStart || refundedAt >= rangeEnd) continue;

          for (const { node: rli } of refund.refundLineItems.edges) {
            const pid = rli.lineItem && rli.lineItem.product && rli.lineItem.product.id;
            if (!pid || !idSet.has(pid)) continue;
            totals[pid].returnedUnits += rli.quantity;
          }
        }
      }

      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
      page += 1;
    }

    res.status(200).json({
      returns: totals,
      ordersScanned,
      partial,
      dateRange: { startDate, endDate },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

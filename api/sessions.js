const { shopifyGraphQL } = require("../lib/shopify");

// Sessions/conversion rate live in Shopify's analytics engine, not the
// standard product/order data. The only way to reach them is ShopifyQL via
// the shopifyqlQuery field, which requires the read_reports scope PLUS
// Shopify's Level 2 Protected Customer Data approval - even though this
// query never touches customer data. Until that approval is in place,
// Shopify returns an access-denied error, which this function catches and
// reports clearly rather than failing the whole dashboard.
//
// Sessions are only tracked by landing page path, not by product ID, so we
// match rows back to products by their storefront handle (/products/<handle>).
function buildQuery(startDate, endDate) {
  return (
    `FROM sessions SHOW sessions, conversion_rate ` +
    `WHERE landing_page_path IS NOT NULL ` +
    `GROUP BY landing_page_path ` +
    `SINCE ${startDate} UNTIL ${endDate} ` +
    `ORDER BY sessions DESC`
  );
}

const SHOPIFYQL_QUERY = `
  query SessionsByLandingPage($query: String!) {
    shopifyqlQuery(query: $query) {
      __typename
      ... on TableResponse {
        tableData {
          columns {
            name
          }
          rows
        }
      }
      parseErrors
    }
  }
`;

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

  const { handles, startDate, endDate } = body || {};

  if (!Array.isArray(handles) || handles.length === 0) {
    res.status(400).json({ error: "handles array is required" });
    return;
  }
  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate are required (YYYY-MM-DD)" });
    return;
  }

  try {
    const data = await shopifyGraphQL(SHOPIFYQL_QUERY, {
      query: buildQuery(startDate, endDate),
    });

    const result = data.shopifyqlQuery;

    if (result.parseErrors && result.parseErrors.length > 0) {
      res.status(200).json({
        available: false,
        reason: "ShopifyQL parse error",
        details: result.parseErrors,
        sessions: {},
      });
      return;
    }

    if (result.__typename !== "TableResponse") {
      res.status(200).json({
        available: false,
        reason: `Unexpected response type: ${result.__typename}`,
        sessions: {},
      });
      return;
    }

    const columns = result.tableData.columns.map((c) => c.name);
    const pathIdx = columns.indexOf("landing_page_path");
    const sessionsIdx = columns.indexOf("sessions");
    const conversionIdx = columns.indexOf("conversion_rate");

    const handleSet = new Set(handles);
    const sessions = {};

    for (const row of result.tableData.rows) {
      const path = row[pathIdx];
      if (!path || !path.startsWith("/products/")) continue;

      const handle = path.replace("/products/", "").split("?")[0];
      if (!handleSet.has(handle)) continue;

      sessions[handle] = {
        sessions: Number(row[sessionsIdx]) || 0,
        conversionRate: Number(row[conversionIdx]) || 0,
      };
    }

    res.status(200).json({ available: true, sessions });
  } catch (err) {
    // Most likely cause right now: the app doesn't yet have read_reports +
    // Protected Customer Data (Level 2) approval. Report it as a soft
    // failure so the rest of the dashboard still renders.
    console.error(err);
    res.status(200).json({
      available: false,
      reason: err.message,
      sessions: {},
    });
  }
};

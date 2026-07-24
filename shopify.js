const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

/**
 * Runs a GraphQL query/mutation against the Shopify Admin API.
 * Throws on transport errors or GraphQL "errors" array.
 */
async function shopifyGraphQL(query, variables = {}) {
  if (!DOMAIN || !TOKEN) {
    throw new Error(
      "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN env vars."
    );
  }

  const res = await fetch(
    `https://${DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  if (json.data === null) {
    throw new Error(`Shopify GraphQL returned no data: ${JSON.stringify(json)}`);
  }

  return json.data;
}

/**
 * Pulls the value of a tag formatted like "style:boho-tunic-014" -> "boho-tunic-014"
 * Returns null if no matching tag is found.
 */
function extractPrefixedTag(tags, prefix) {
  const match = tags.find((t) => t.toLowerCase().startsWith(`${prefix}:`));
  return match ? match.slice(prefix.length + 1) : null;
}

module.exports = { shopifyGraphQL, extractPrefixedTag };

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

// Shopify custom apps created via the Dev Dashboard no longer issue a
// permanent token. Instead the app exchanges its client ID + secret for a
// short-lived access token (client credentials grant), valid ~24 hours.
// We cache it in memory for the life of the serverless function's warm
// instance so we're not re-authenticating on every single request.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (!DOMAIN || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET env vars."
    );
  }

  // Reuse the cached token if it still has at least 60s of life left
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60000) {
    return cachedToken;
  }

  const res = await fetch(`https://${DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token request failed ${res.status}: ${text}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;
  // expires_in is in seconds (typically 86399, ~24h)
  cachedTokenExpiresAt = Date.now() + json.expires_in * 1000;

  return cachedToken;
}

/**
 * Runs a GraphQL query/mutation against the Shopify Admin API.
 * Throws on transport errors or GraphQL "errors" array.
 */
async function shopifyGraphQL(query, variables = {}) {
  const token = await getAccessToken();

  const res = await fetch(
    `https://${DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
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

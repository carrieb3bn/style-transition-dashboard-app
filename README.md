# Style Transition Dashboard

Tracks sales for style pairs that are mid-transition from an old vendor to
in-house manufacturing — vendor units/revenue/AOV/sell-through side by side
with the manufacturing version, for as long as both are live.

Static `index.html` + Vercel serverless functions, no framework — same
pattern as the Faire Product Launcher.

## How pairing works

The app reads two tags you apply in Shopify:

- `style:<shared-key>` — put the **same** value on both the vendor product
  and its manufacturing replacement. This is what links them into a pair.
  Example: `style:boho-tunic-014`.
- `source:vendor` or `source:manufacturing` — marks which side of the pair
  a product is on.

A product missing the `style:` tag won't show up at all (nothing to pair it
with). A style with only one side tagged still shows, with the other side
marked as not yet listed.

## Setup

1. **Create a custom app in Shopify** (Settings → Apps and sales channels →
   Develop apps) with these Admin API scopes:
   - `read_products`
   - `read_orders`
   - `read_inventory`

   Install it and copy the Admin API access token.

2. **Tag your products** in Shopify with the `style:` and `source:` tags
   described above.

3. **Set environment variables** in Vercel's project settings (Settings →
   Environment Variables):
   - `SHOPIFY_STORE_DOMAIN`
   - `SHOPIFY_ADMIN_ACCESS_TOKEN`
   - `SHOPIFY_API_VERSION` (optional, defaults to `2024-10`)

   Copy `.env.example` to `.env.local` if you want to test locally with
   `vercel dev`.

4. **Push to GitHub, import into Vercel** — same as your other tools, web UI
   only, no CLI needed. Vercel auto-detects the `api/` folder as serverless
   functions and serves `index.html` as the static root.

## Files

- `index.html` — the entire frontend: markup, styles, and vanilla JS
- `api/pairs.js` — serverless function that fetches and groups vendor /
  manufacturing products by shared `style:` tag
- `api/sales.js` — serverless function that pages through orders in a date
  range and aggregates units/revenue/AOV per product
- `lib/shopify.js` — shared Admin API GraphQL client used by both functions

## Notes on the sales query

Shopify's standard Admin API doesn't have a single "sales by product"
endpoint, so this app pages through orders in the selected date range and
sums line items that match your tagged product IDs. For date ranges with a
very large number of orders, the API route caps itself at 6,000 orders or
~50 seconds (whichever comes first) and flags the result as `partial` — if
you see that flag, narrow the date range and re-run.

If your store is on **Shopify Plus with ShopifyQL access**, this could later
be swapped for a `shopifyqlQuery` call, which would be faster and avoid the
paging cap entirely — worth revisiting if order volume here grows.

## Sell-through rate

Calculated per product as:

```
units sold / (units sold + current inventory on hand)
```

For the vendor side, this rises toward 100% as the old stock depletes. For
the manufacturing side, it reflects demand against whatever's currently been
produced — it resets lower each time you receive a new production run,
since inventory goes back up.

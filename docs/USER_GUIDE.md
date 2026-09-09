# Referly user guide

How the platform works end to end, and how to run every process in it. Written for the person operating a workspace (the merchant), with a section for affiliates and one for the platform admin.

## 1. The model in one page

Referly tracks who sent a customer and pays the sender. Five objects carry that:

| Object | What it is | Where |
|---|---|---|
| **Offer** | A product or service affiliates promote, with a price and the URL the customer lands on. | Offers |
| **Program** | The rules: commission, attribution window, approval, holding period, refund policy, terms. A program contains offers. | Programs |
| **Affiliate** | A partner with a portal login, links and coupon codes. An affiliate joins one or more programs. | Affiliates |
| **Conversion** | A sale (or a lead) reported by your checkout, API, form or by hand. Attributed to an affiliate by click or coupon. | Conversions, Leads |
| **Commission** | Money owed for a conversion: pending → approved → payable → paid, or reversed. Paid in payout batches. | Commissions, Payouts |

The flow: an affiliate shares a link → a click is recorded → the customer buys → your checkout posts the order → Referly attributes it and creates a commission → the holding period passes → the commission becomes payable → you pay it in a batch.

Everything else (campaigns, groups, tiers, automation, disputes, webhooks, messages, notifications) sits on top of that flow.

## 2. Setting up a workspace

1. **Sign up** at `/signup`: business name, a slug, currency, and the owner account. Verify the email from the link you receive.
2. **Settings → Business and branding**: legal name, website, support email, logo, primary colour (used on the portal and emails), tone of voice for messages, timezone.
3. **Settings → Defaults**: attribution window, holding days, approval mode, payout cadence and threshold. New programs start from these.
4. **Settings → Team**: add members with a role. Owner: everything. Admin: everything except billing and team. Marketing: campaigns, assets, messages. Read-only: view.
5. **Settings → Integrations → Create API key**: pick scopes. `conversions.write` is what your checkout needs. Keys are shown once.
6. **Settings → Payout providers**: connect Stripe Connect or PayPal Payouts if you want to send money from the platform. Manual payouts work without either.
7. **Settings → SMS and WhatsApp**: connect Twilio if you want text notifications to affiliates.

## 3. Offers and programs

**Create an offer** (Offers → New offer): name, type, price, sales URL (where the customer lands), image. Activate it. Offers can be paused or archived later; archived offers stop accepting new links.

**Create a program** (Programs → New program):

- **Commission**: percentage of the sale or a fixed amount, and the basis (gross, net, or eligible amount).
- **Attribution**: last touch or first touch, and the window in days. Coupon wins or link wins when both are present.
- **Approval**: manual (you approve applications), auto (applicants are active at once), invite only.
- **Holding period**: days a commission waits before it becomes payable. Refunds inside it reduce or reverse it.
- **Refund policy**: full reversal, proportional reduction, or keep the commission.
- **Terms**: shown to applicants; editing bumps the version and affiliates re-accept.
- **Offers**: which offers the program covers. A per-offer commission override is available on the program page.
- **Test mode**: track everything, create no payable money.

Activate the program. The program page gives you the **application page link** (`/join/<token>`) to share.

**Rate tiers** (program page → Tiers card): by group with a priority order, or by performance (sales or revenue over a lifetime or rolling window). Precedence when a commission is calculated: live campaign > affiliate override > tier > program-offer override > program.

**Leads** (program page → Leads card): turn on pay-per-lead, set the commission per qualified lead, manual or automatic qualification, and the dedupe window. This mints a capture endpoint for forms on your site.

## 4. Adding affiliates

Four ways in:

1. **Application page.** Share the program's join link. Applicants fill in name, email, password, channels and answers, and accept the terms. With manual approval they land in Affiliates as "applied"; approve or reject them there. With auto approval they are active immediately.
2. **Invite** (Affiliates → Invite an affiliate): email and program. They get a link, set a password and accept the terms. Invited affiliates are active at once.
3. **Add manually** (Affiliates → Add manually): name, email, programs. No portal login until they set a password through "forgot password".
4. **API**: create affiliates with an API key that has `affiliates.write`.

On an **affiliate's page** you can: approve, reject, suspend (with a reason) or reactivate; set a commission override per program; add them to groups; create coupon codes; see links, conversions, ledger and balances; record a manual balance adjustment; erase their personal data on request.

Affiliates get an email and an in-app notification at each step.

## 5. Links, coupons and tracking

- Affiliates create links in the portal (Links & Codes); each link is unique to them and can carry a label per placement.
- A link `/r/<token>` records a click, sets a cookie for the attribution window, and redirects to the offer's sales URL with `?ref=<click token>` appended.
- **Your checkout must forward that click token** when it reports the order (see section 7). The cookie only helps when the checkout shares the API's domain.
- **Coupon codes** (affiliate page → New coupon code) attribute without a click: a sale reporting the code is attributed to the code's affiliate. The program's precedence setting decides what wins when both a click and a code are present.
- Clicks from bots, iframes and script loads are refused; consent state is recorded per click.

**Website tracking snippet**: paste one script on your site and the journey is recorded without any checkout work. Setup in section 6.

## 6. Website tracking snippet

The snippet records the complete journey of every visitor who arrives through an affiliate link, on your own website, with one paste. Once it is in place you get, without touching your checkout: the click token kept for the whole attribution window, every page the visitor opens, any event you choose to send, lead forms that carry the attribution by themselves, and (optionally) the order reported straight from your thank-you page.

### 6.1 Turn it on

1. Go to **Settings → Integrations → Website tracking** and click **Turn on website tracking**. This creates your site key; it is public and identifies your workspace, nothing more.
2. Copy the install snippet shown in the card. It is two lines:

```html
<script>window.referly=window.referly||function(){(window.referly.q=window.referly.q||[]).push(arguments)};</script>
<script async src="https://YOUR-API-DOMAIN/referly.js" data-site="site_xxxxxxxxxxxxxxxxxxxxxxxx"></script>
```

3. Paste it on **every page** of your site, ideally before `</head>`. Where to put it:
   - **Static site or your own templates**: in the shared header layout.
   - **WordPress**: Appearance → Theme file editor → `header.php`, or a "header scripts" plugin, or your theme's custom code box.
   - **Shopify**: Online store → Themes → Edit code → `theme.liquid`, before `</head>`. Add the order call (6.5) to the checkout's additional scripts or the thank-you page customisation.
   - **Webflow, Framer, Squarespace, Wix**: the site-wide "custom code" or "head code" setting.
   - **Google Tag Manager**: a Custom HTML tag fired on All Pages.
   - **React, Next.js, Vue, single-page apps**: in the root HTML document once; route changes are tracked automatically.
4. Open any page of your site. Within a few seconds the card reads "Last event … from your-domain", which confirms the install. Until then it says "Waiting for the first event".

The script loads asynchronously, weighs about 3 KB, has no dependencies, and never blocks or breaks the page: if the API is unreachable, it silently does nothing.

### 6.2 Lock it to your domains

In the same card, enter your website's hostnames (`shop.example.com, example.com`) and **Save**. From then on only pages on those hosts and their subdomains can report under your key. Leave the field empty while testing on a staging domain or localhost; set it before going live and before accepting orders from the snippet.

### 6.3 What is recorded automatically

- **The click token.** An affiliate link `/r/<token>` redirects to your offer URL with `?ref=<click token>`. The snippet stores it in a first-party cookie on your domain for the program's attribution window (the server tells it the exact length), so it survives navigation, reloads and return visits.
- **A visitor id** (first party, one year) and a **session id** (a new one after 30 minutes of inactivity).
- **Page views**: URL, path, title and the referrer of the landing page, including route changes in single-page apps.

Visitors who did not come through an affiliate link are recorded too, but the Journeys page hides them unless you switch to "All visitors", which is there for comparison. No names, emails or IP addresses are stored by the snippet.

### 6.4 Send your own events

Anywhere on your site, after the snippet:

```html
<script>referly('track', 'add_to_cart', { sku: 'SKU-123', value: 49 });</script>
```

The first argument is the event name (up to 80 characters), the second an optional object of simple properties (strings, numbers, booleans; nested values are stringified, 2 KB per event). Typical events: `add_to_cart`, `checkout_started`, `signup_started`, `demo_booked`, `video_watched`. They show on the journey timeline and count as "engaged" on the Journeys page. Calls made before the script has loaded are queued and sent once it has.

### 6.5 Report orders from the thank-you page (optional)

Turn on **Accept orders reported by the snippet** in the card (it needs at least one domain) and add to your order-confirmation page:

```html
<script>
  referly('convert', {
    orderId: 'ORDER-1001',          // required, the idempotency key
    amount: 129.00,                 // major units; or amountMinor: 12900
    currency: 'USD',                // optional, defaults to your workspace currency
    email: 'buyer@example.com',     // optional, stored only as a hash
    couponCode: 'SAM20'             // optional
  });
</script>
```

The sale is attributed exactly like any other (click token, the visitor's recorded clicks, or coupon), goes through the same holding period and approval, and is recorded with source `pixel` so you can tell it apart. Repeating an order id never double-pays. Because a browser call can be forged more easily than a server call, keep the domain list tight and prefer the checkout post (section 7) where you can; use the snippet when you cannot change the checkout at all. The call returns a promise resolving to `{ ok, conversionId, duplicate, attributed }` if you want to check it.

### 6.6 Lead forms

Add two hidden inputs to any form that posts to a program's capture endpoint (section 7):

```html
<input type="hidden" name="ref">
<input type="hidden" name="referly_visitor">
```

The snippet fills them in on load and again on submit, so the lead is attributed even when the form is on a page the visitor reached several clicks after landing.

### 6.7 Your own integrations

- `referly('ref')` returns the current click token; `referly('visitor')` the visitor id. Send either with your server-side conversion post (`clickToken` or `visitorId` in the body): the visitor id works even after the cookie is gone, because Referly remembers which clicks that visitor arrived through.
- `referly('page')` records a page view by hand (for apps that manage their own routing); `referly('flush')` sends what is queued immediately.
- Add `data-auto="false"` to the script tag to switch off automatic page views and form filling and call `referly('page')` yourself.

### 6.8 Reading the journeys

**Journeys** (main navigation) lists every visit that came through an affiliate link: when it started, the affiliate, the landing page, pages and events, the outcome (browsing, engaged, lead, converted) and last activity. Filter by affiliate, show converted visits only, or all visitors for comparison; pick the last 7, 30 or 90 days. **View journey** opens the visitor's whole history across visits as a timeline. The same timeline appears on each conversion page under "Website journey", so a disputed or surprising sale can be checked against what the buyer actually did.

### 6.9 If nothing shows up

- View the page source and confirm both script lines are present with your site key.
- Open the browser console: a red request to `/t/<site key>/events` with a 404 means the key is wrong, the workspace is suspended, or the page's domain is not in your domain list.
- Content blockers on your own machine can block the script; test in a private window.
- Journeys only list visits that arrived through an affiliate link by default; switch to "All visitors" to confirm the snippet works before any affiliate has sent traffic.
- Rotating the site key (button in the card) invalidates the old snippet immediately; update the script tag afterwards.

Journey events are kept for the period set under Settings → Data (90 days by default) and are included in backups and the workspace export.

## 7. Getting sales in

**Checkout webhook or API** (recommended): after an order, POST to `/v1/conversions` with the API key:

```json
{ "externalOrderId": "order_123", "offerId": "off_…", "amountMinor": 12900, "currency": "USD", "clickToken": "<ref from the landing URL>", "couponCode": "SAM20", "customerEmail": "buyer@example.com" }
```

Repeating the same `externalOrderId` returns the original record and never double-pays. Every call is logged as a webhook delivery so you can debug integrations.

**Manual** (Conversions → Record manually): order id, offer, amount, and either a coupon code or an explicit affiliate with a reason (audited).

**Refunds and cancellations**: on the conversion page. A refund reduces or reverses the commission according to the program's refund policy; a cancellation voids it. Both are reflected in the affiliate's ledger.

**Correcting attribution**: conversion page → Correct attribution. The old commission is voided and a new one created for the right affiliate, with the reason recorded.

**Leads** (pay-per-lead): send them to `/v1/leads` with the API key, record them on the Leads page, or point a form on your site at the program's capture endpoint (JSON or form fields, forward `ref` from the landing page, optional `redirect` to a thank-you page). Leads wait on the Leads page until you **qualify** (commission approved, then holding period) or **disqualify** (commission voided). A repeat email inside the program's dedupe window is a duplicate and earns nothing.

**From the website snippet**: with website tracking on and snippet orders accepted (section 6), the thank-you page reports the order itself. Such sales carry source `pixel`; review them like any other and prefer the checkout post where you can.

## 8. Commissions, holding periods and payouts

- A commission is created **pending** with the amount fixed at that moment (the calculation basis is stored on it).
- It becomes **payable** automatically when the holding period ends, unless the sale is refunded, cancelled or disputed. You can approve earlier from Commissions.
- **Payouts**: create a draft batch for one affiliate or for everyone with a payable balance above the threshold. Pay it outside the platform and click "Record paid", or send it through Stripe Connect or PayPal from the batch. Affiliates set their payout method in the portal; Stripe Connect onboarding happens from there too.
- **Adjustments**: add or deduct an amount on an affiliate's balance with a reason (bonuses, clawbacks).
- The **ledger** is append-only. Every credit, reversal, clawback, adjustment and payout is a line the affiliate can see and print as a statement.

## 9. Campaigns

Time-bound promotions per program (Campaigns → New campaign): dates, an optional commission override that applies while the campaign is live, an optional once-per-affiliate bonus on a threshold of sales or revenue, campaign assets, and participants. Invite affiliates or groups; they join from the portal to unlock the campaign rate and creative. Campaigns end themselves at the end date, and performance is broken out in Analytics.

## 10. Groups

Groups (Groups page) classify affiliates: partner type, channel, geography, negotiated rate. They are used for rate tiers, asset access, campaign invitations and automation conditions. Add members from the Groups page or from each affiliate's page.

## 11. Assets

Assets page: upload banners, files and copy, or link to a URL. Assign access to everyone, specific groups, or specific affiliates. Affiliates download approved creative from their portal.

Copy and guideline text can carry merge fields: `{{link}}` (the affiliate's own tracking link, created for them if they have none), `{{coupon_code}}`, `{{affiliate_name}}`, `{{business_name}}`, `{{offer_name}}`, `{{offer_url}}`, `{{commission}}` and `{{portal_url}}`. Write the text once; every affiliate sees it filled in with their own details and can paste it straight into a post.

## 12. Messages and notifications

- **Messages → Templates**: every email and text the platform sends, per tone. Variables are fixed and safe. Edit the wording, never the logic.
- **Delivery log**: every email and text with status and provider response.
- **Notifications**: the bell shows unread items; the Notifications page lists applications, sales, leads, disputes, failed payouts and tasks. Each team member switches categories off for their own feed. Affiliates have the same in their portal, including email switches.
- **Texts**: with Twilio connected, affiliates who opt in (portal → Text notifications) get SMS or WhatsApp copies of key messages. STOP and START are honoured.

## 13. Automation

Automation page: rules are **trigger + conditions + actions + stop conditions**. Triggers are domain events (affiliate applied, conversion recorded, commission approved, payout failed, dispute opened…). Conditions filter by program, offer, campaign, affiliate, tag, status, amount or source. Actions: send a template or custom email or text, approve, add or remove a tag, adjust a balance, create a task, suspend. Stop conditions prevent repeats. Every run is logged with what matched and what ran. Tasks created by rules show on Home under "Needs attention".

## 14. Disputes

A merchant can dispute a sale (fraud, refund, amount). An affiliate can claim a missing attribution or a wrong amount from the portal. Opening a dispute holds the sale and its commission. Review it, link related sales, discuss in the thread, then resolve: restore the sale, cancel it and void the commission, or reattribute it. Affiliates are notified at each step.

## 15. Analytics, journeys and exports

Journeys: every visit that came through an affiliate link, with the landing page, pages viewed, custom events, and whether it ended in a sale or lead; open a row for the visitor's whole history across visits. Filter by affiliate, converted only, or all visitors (including direct traffic, for comparison). Needs the website tracking snippet (section 6).

Analytics: clicks, sales, attributed revenue, commission and new affiliates over time with comparison to the previous period; the click → attributed → approved funnel; breakdowns by affiliate, offer, program, campaign, group and attribution source. Exports build in the background (affiliates, conversions, commissions, payouts, ledger, clicks as CSV; the whole workspace as JSON lines) and stay downloadable for 7 days.

## 16. Webhooks

Webhooks page: endpoints for Zapier, Make or your own systems. Pick events, get a signing secret (shown once), and every delivery is signed, retried with backoff and logged with the response. Endpoints pause themselves after repeated failures and a task tells you. Redeliver from the log.

## 17. Data, retention and privacy

Settings → Data: how long clicks, message logs, audit trail, webhook deliveries, automation runs, notifications, lead contact details and website journey events are kept. Financial records are never deleted. Export the whole workspace from the same card. Affiliates can request erasure from their portal; carry it out from their page once nothing is owed.

## 18. The affiliate portal

Affiliates sign in at `/login` and see: **Home** (earnings, clicks, recent sales, campaigns, quick actions), **Offers** they can promote with their commission, **Links & Codes**, **Assets**, **Campaigns**, **Conversions**, **Leads**, **Earnings** (statement, printable), **Payouts** (method, Stripe Connect onboarding), **Disputes**, **Notifications**, **Profile** (details, text notifications, password, data requests, terms accepted).

## 19. Platform admin

Sign in with the platform admin account (created from the environment on first boot) and you land on `/admin`: workspaces with usage, plan and custom limits, suspend, close (purged after the grace period) or reactivate, the operations panel (queue, webhooks, messages, backups, retention), dead jobs with retry.

## 20. Operating checklist

Weekly: review applications, open disputes and pending leads (Home → Needs attention); create payout batches; check the delivery log for failed sends.

Monthly: read Analytics with the previous-period comparison; review automation runs; confirm backups are recent on the admin overview.

When something looks wrong: the conversion page shows attribution history and the audit trail; the affiliate page shows the ledger; the Messages delivery log shows what was sent; every API error carries a request id you can find in the logs.

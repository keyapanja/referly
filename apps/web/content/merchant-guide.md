# Running your affiliate program

How the platform works end to end, and how to run every process in it. Written for the person operating the workspace. Your affiliates have their own guide in the portal, and it is worth skimming so you know what they see.

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

Everything for this lives on the **Website tracking** page in the sidebar.

1. Open **Website tracking** and click **Turn on website tracking**. This creates your site key; it is public and identifies your workspace, nothing more.
2. Under **Install on your site**, pick where your site is built: Custom website, WordPress, Shopify, Webflow, Wix or Squarespace, Google Tag Manager, or React and single-page apps. The page then shows the click path for that platform and the exact code to paste, with your site key already in it, so nothing needs assembling.
3. Paste it on **every page**, before `</head>`. The code is the same two lines everywhere; only the place you put it differs:

```html
<script>window.referly=window.referly||function(){(window.referly.q=window.referly.q||[]).push(arguments)};</script>
<script async src="https://YOUR-API-DOMAIN/referly.js" data-site="site_xxxxxxxxxxxxxxxxxxxxxxxx"></script>
```

4. Load any page of your site. Within a few seconds the status at the top of the page turns to **Receiving** and names the host it heard from. Until then it reads **Waiting**.

The script loads asynchronously, weighs about 4 KB, has no dependencies, and never blocks or breaks the page: if the API is unreachable, it silently does nothing.

**On WordPress, install the Referly plugin instead of pasting code.** Choose WordPress on the page, click **Download the plugin**, and install it in WordPress under Plugins, Add New Plugin, Upload Plugin. Then click **Create connection key**, and paste the key in WordPress under Settings, Referly. The plugin adds the tracking code to every page and reports each paid WooCommerce order from your server, FunnelKit checkouts included, so a customer who closes the tab at an upsell or during a payment redirect is still counted. Refunds you make in WooCommerce follow automatically. Nothing goes on your thank-you page, so skip 6.5.

Shopify needs one extra piece to report orders: a Liquid block for its order status page, which the page shows. See 6.5.

### 6.2 Lock it to your domains

On the same page, under **Lock it to your domains**, enter your website's hostnames (`shop.example.com, example.com`) and **Save**. From then on only pages on those hosts and their subdomains can report under your key. Leave the field empty while testing on a staging domain or localhost; set it before going live and before accepting orders from the snippet.

### 6.3 What is recorded automatically

- **The click token.** An affiliate link `/r/<token>` redirects to your offer URL with `?ref=<click token>`. The snippet stores it in a first-party cookie on your domain for the program's attribution window (the server tells it the exact length), so it survives navigation, reloads and return visits.
- **A visitor id** (first party, one year) and a **session id** (a new one after 30 minutes of inactivity).
- **Page views**: URL, path, title and the referrer of the landing page, including route changes in single-page apps.

Visitors who did not come through an affiliate link are not tracked at all: for them the snippet writes no cookie and sends nothing. No names, emails or IP addresses are stored by the snippet.

### 6.4 Send your own events

Anywhere on your site, after the snippet:

```html
<script>referly('track', 'add_to_cart', { sku: 'SKU-123', value: 49 });</script>
```

The first argument is the event name (up to 80 characters), the second an optional object of simple properties (strings, numbers, booleans; nested values are stringified, 2 KB per event). Typical events: `add_to_cart`, `checkout_started`, `signup_started`, `demo_booked`, `video_watched`. They show as steps in the visitor's journey. Calls made before the script has loaded are queued and sent once it has.

### 6.5 Report orders from the thank-you page (optional)

Switch on **Accept orders reported from my thank-you page** (it needs at least one domain first), then use the code the page shows for your platform. Shopify fills in the order values for you. On WordPress with WooCommerce, skip this and leave the switch off: the Referly plugin from 6.1 reports orders from your server instead. Referly recognises an order number it has already seen, so nothing is counted twice, but there is no reason to send the same order two ways. On any other platform it is this, with your own values:

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

### 6.6 Cookie consent (EU sites)

If your site shows a cookie banner, switch on **Wait for cookie consent before tracking** on the Website tracking page and re-copy the install code: it now carries `data-consent="wait"`. Until your banner reports a decision the snippet writes no cookie, no local storage and no session entry, and sends nothing; the API refuses anything that arrives without consent, so a misconfigured page cannot leak past the switch.

How the decision reaches the snippet:

- **Cookiebot** and **OneTrust** are recognised automatically. Cookiebot's statistics or marketing category counts as consent; OneTrust's performance (C0002) or targeting (C0004) group does.
- **Any other banner**: call `referly('consent', 'granted')` from your accept handler and `referly('consent', 'denied')` from your decline handler. A `referly:consent` DOM event on `document` with detail `granted` or `denied` works too, if your banner only emits events.

What happens on each outcome:

- **Granted**: the click token and visitor id are written, everything that happened while the banner was open is sent, and the events are stored marked as consented. The decision is remembered for 180 days, so later pages track immediately.
- **Denied**: the queued events are discarded, any ids already in the browser are deleted, hidden visitor inputs are blanked, and nothing further is sent. Only the decision itself is remembered.

Orders reported from the thank-you page still go through while consent is pending or denied, because an order is contract data rather than analytics, but they travel **without** the visitor id, so they are attributed by the click token or coupon alone and do not appear on a journey. If your legal position is that even that requires consent, leave the thank-you page call inside your banner's consented branch.

### 6.7 Lead forms

Add two hidden inputs to any form that posts to a program's capture endpoint (section 7):

```html
<input type="hidden" name="ref">
<input type="hidden" name="referly_visitor">
```

The snippet fills them in on load and again on submit, so the lead is attributed even when the form is on a page the visitor reached several clicks after landing.

### 6.8 Your own integrations

- `referly('ref')` returns the current click token; `referly('visitor')` the visitor id. Send either with your server-side conversion post (`clickToken` or `visitorId` in the body): the visitor id works even after the cookie is gone, because Referly remembers which clicks that visitor arrived through.
- `referly('page')` records a page view by hand (for apps that manage their own routing); `referly('flush')` sends what is queued immediately.
- Add `data-auto="false"` to the script tag to switch off automatic page views and form filling and call `referly('page')` yourself.

### 6.9 Reading the journeys

**Journeys** (main navigation) lists every visit that came through an affiliate link: when it happened, which affiliate sent it, and the result: bought, with the amount, signed up, or no purchase. Choose an affiliate and the last 7, 30 or 90 days. **View** shows what that person did as a short list of steps: the pages they viewed, anything your site reported, and the purchase. The same steps appear on each sale's page under "Website journey", so a surprising sale can be checked against what the buyer actually did.

### 6.10 If nothing shows up

- View the page source and confirm both script lines are present with your site key.
- Open the browser console: a red request to `/t/<site key>/events` with a 404 means the key is wrong, the workspace is suspended, or the page's domain is not in your domain list.
- Content blockers on your own machine can block the script; test in a private window.
- Journeys only ever show visits that arrived through an affiliate link. To test, open one of your own affiliate links in a private window and browse from there.
- Rotating the site key (bottom of the Website tracking page) invalidates the old snippet immediately; update the code on your site straight after.
- With consent mode on, nothing is recorded until your banner reports consent: check `referly('consent')` in the console; `pending` means your banner never called it.

Journey events are kept for the period set under Settings → Data (90 days by default) and are included in backups and the workspace export.

## 7. Getting sales in


**Checkout webhook or API** (recommended): after an order, POST to `/v1/conversions` with the API key:

```json
{ "externalOrderId": "order_123", "offerId": "off_…", "amountMinor": 12900, "currency": "USD", "clickToken": "<ref from the landing URL>", "couponCode": "SAM20", "customerEmail": "buyer@example.com" }
```

Repeating the same `externalOrderId` returns the original record and never double-pays. Every call is logged as a webhook delivery so you can debug integrations.

Referly only keeps sales that came through an affiliate. An order with no valid affiliate click and no affiliate's coupon code is answered with `recorded: false` and not stored, so you can send every order and let Referly decide.

**Manual** (Conversions → Record manually): order id, offer, amount, and either a coupon code or an explicit affiliate with a reason (audited). A manual sale that matches no affiliate is refused, so pick the affiliate. This is also how you credit an affiliate for a sale their link missed.

**Refunds and cancellations**: on the conversion page. A refund reduces or reverses the commission according to the program's refund policy; a cancellation voids it. Both are reflected in the affiliate's ledger.

**Correcting attribution**: conversion page → Correct attribution. The old commission is voided and a new one created for the right affiliate, with the reason recorded.

**Leads** (pay-per-lead): send them to `/v1/leads` with the API key, record them on the Leads page, or point a form on your site at the program's capture endpoint (JSON or form fields, forward `ref` from the landing page, optional `redirect` to a thank-you page). Leads wait on the Leads page until you **qualify** (commission approved, then holding period) or **disqualify** (commission voided). A repeat email inside the program's dedupe window is a duplicate and earns nothing.

**From the website snippet**: with website tracking on and snippet orders accepted (section 6), the thank-you page reports the order itself. Such sales carry source `pixel`; review them like any other and prefer the checkout post where you can.

## 8. Commissions, holding periods and payouts


- A commission is created **pending** with the amount fixed at that moment (the calculation basis is stored on it).
- It becomes **payable** automatically when the holding period ends, unless the sale is refunded, cancelled or disputed. Only payable money can go into a payout — until then the Commissions page shows the date it is held to.
- **Pay now** (Commissions page) ends the holding period for one commission straight away, so you can pay it today. The sale must not be under dispute.
- **Payouts**: "Waiting to be paid" lists every affiliate with what is payable today and what is still held, and until when. Create a draft batch from that row, or one for everyone with a payable balance above the threshold. Pay it outside the platform and click "Record paid", or send it through Stripe Connect or PayPal from the batch. Affiliates set their payout method in the portal; Stripe Connect onboarding happens from there too.
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


Journeys: every visit that came through an affiliate link, with the affiliate and whether it ended in a purchase; open one to see the steps. Needs the website tracking snippet (section 6).

Analytics: clicks, sales, attributed revenue, commission and new affiliates over time with comparison to the previous period; the click → attributed → approved funnel; breakdowns by affiliate, offer, program, campaign, group and attribution source. Exports build in the background (affiliates, conversions, commissions, payouts, ledger, clicks as CSV; the whole workspace as JSON lines) and stay downloadable for 7 days.

## 16. Webhooks


Webhooks page: endpoints for Zapier, Make or your own systems. Pick events, get a signing secret (shown once), and every delivery is signed, retried with backoff and logged with the response. Endpoints pause themselves after repeated failures and a task tells you. Redeliver from the log.

## 17. Data, retention and privacy


Settings → Data: how long clicks, message logs, audit trail, webhook deliveries, automation runs, notifications, lead contact details and website journey events are kept. Financial records are never deleted. Export the whole workspace from the same card. Affiliates can request erasure from their portal; carry it out from their page once nothing is owed.

## 18. What your affiliates see

Affiliates sign in at the same address and land in the partner portal: **Home** (earnings, clicks, recent sales, campaigns), **Offers** they may promote with their commission, **Links & Codes**, **Assets** with your copy already filled in with their own link and code, **Campaigns**, **Conversions**, **Leads**, **Earnings** (a printable statement), **Payouts** (their method and onboarding), **Disputes**, **Notifications**, **Profile** (details, text notifications, password, data requests, terms accepted) and their own **Guide**.

They never see your notes, provider references, other affiliates, customer contact details or the lead contacts behind their leads. If a partner asks how something works, point them at Guide in their portal.

## 19. Operating checklist


Weekly: review applications, open disputes and pending leads (Home → Needs attention); create payout batches; check the delivery log for failed sends.

Monthly: read Analytics with the previous-period comparison; review automation runs; confirm backups are recent on the admin overview.

When something looks wrong: the conversion page shows attribution history and the audit trail; the affiliate page shows the ledger; the Messages delivery log shows what was sent; every API error carries a request id you can find in the logs.

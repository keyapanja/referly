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
- **Your checkout must forward that click token** when it reports the order (see section 6). The cookie only helps when the checkout shares the API's domain.
- **Coupon codes** (affiliate page → New coupon code) attribute without a click: a sale reporting the code is attributed to the code's affiliate. The program's precedence setting decides what wins when both a click and a code are present.
- Clicks from bots, iframes and script loads are refused; consent state is recorded per click.

## 6. Getting sales in

**Checkout webhook or API** (recommended): after an order, POST to `/v1/conversions` with the API key:

```json
{ "externalOrderId": "order_123", "offerId": "off_…", "amountMinor": 12900, "currency": "USD", "clickToken": "<ref from the landing URL>", "couponCode": "SAM20", "customerEmail": "buyer@example.com" }
```

Repeating the same `externalOrderId` returns the original record and never double-pays. Every call is logged as a webhook delivery so you can debug integrations.

**Manual** (Conversions → Record manually): order id, offer, amount, and either a coupon code or an explicit affiliate with a reason (audited).

**Refunds and cancellations**: on the conversion page. A refund reduces or reverses the commission according to the program's refund policy; a cancellation voids it. Both are reflected in the affiliate's ledger.

**Correcting attribution**: conversion page → Correct attribution. The old commission is voided and a new one created for the right affiliate, with the reason recorded.

**Leads** (pay-per-lead): send them to `/v1/leads` with the API key, record them on the Leads page, or point a form on your site at the program's capture endpoint (JSON or form fields, forward `ref` from the landing page, optional `redirect` to a thank-you page). Leads wait on the Leads page until you **qualify** (commission approved, then holding period) or **disqualify** (commission voided). A repeat email inside the program's dedupe window is a duplicate and earns nothing.

## 7. Commissions, holding periods and payouts

- A commission is created **pending** with the amount fixed at that moment (the calculation basis is stored on it).
- It becomes **payable** automatically when the holding period ends, unless the sale is refunded, cancelled or disputed. You can approve earlier from Commissions.
- **Payouts**: create a draft batch for one affiliate or for everyone with a payable balance above the threshold. Pay it outside the platform and click "Record paid", or send it through Stripe Connect or PayPal from the batch. Affiliates set their payout method in the portal; Stripe Connect onboarding happens from there too.
- **Adjustments**: add or deduct an amount on an affiliate's balance with a reason (bonuses, clawbacks).
- The **ledger** is append-only. Every credit, reversal, clawback, adjustment and payout is a line the affiliate can see and print as a statement.

## 8. Campaigns

Time-bound promotions per program (Campaigns → New campaign): dates, an optional commission override that applies while the campaign is live, an optional once-per-affiliate bonus on a threshold of sales or revenue, campaign assets, and participants. Invite affiliates or groups; they join from the portal to unlock the campaign rate and creative. Campaigns end themselves at the end date, and performance is broken out in Analytics.

## 9. Groups

Groups (Groups page) classify affiliates: partner type, channel, geography, negotiated rate. They are used for rate tiers, asset access, campaign invitations and automation conditions. Add members from the Groups page or from each affiliate's page.

## 10. Assets

Assets page: upload banners, files and copy, or link to a URL. Assign access to everyone, specific groups, or specific affiliates. Affiliates download approved creative from their portal.

## 11. Messages and notifications

- **Messages → Templates**: every email and text the platform sends, per tone. Variables are fixed and safe. Edit the wording, never the logic.
- **Delivery log**: every email and text with status and provider response.
- **Notifications**: the bell shows unread items; the Notifications page lists applications, sales, leads, disputes, failed payouts and tasks. Each team member switches categories off for their own feed. Affiliates have the same in their portal, including email switches.
- **Texts**: with Twilio connected, affiliates who opt in (portal → Text notifications) get SMS or WhatsApp copies of key messages. STOP and START are honoured.

## 12. Automation

Automation page: rules are **trigger + conditions + actions + stop conditions**. Triggers are domain events (affiliate applied, conversion recorded, commission approved, payout failed, dispute opened…). Conditions filter by program, offer, campaign, affiliate, tag, status, amount or source. Actions: send a template or custom email or text, approve, add or remove a tag, adjust a balance, create a task, suspend. Stop conditions prevent repeats. Every run is logged with what matched and what ran. Tasks created by rules show on Home under "Needs attention".

## 13. Disputes

A merchant can dispute a sale (fraud, refund, amount). An affiliate can claim a missing attribution or a wrong amount from the portal. Opening a dispute holds the sale and its commission. Review it, link related sales, discuss in the thread, then resolve: restore the sale, cancel it and void the commission, or reattribute it. Affiliates are notified at each step.

## 14. Analytics and exports

Analytics: clicks, sales, attributed revenue, commission and new affiliates over time with comparison to the previous period; the click → attributed → approved funnel; breakdowns by affiliate, offer, program, campaign, group and attribution source. Exports build in the background (affiliates, conversions, commissions, payouts, ledger, clicks as CSV; the whole workspace as JSON lines) and stay downloadable for 7 days.

## 15. Webhooks

Webhooks page: endpoints for Zapier, Make or your own systems. Pick events, get a signing secret (shown once), and every delivery is signed, retried with backoff and logged with the response. Endpoints pause themselves after repeated failures and a task tells you. Redeliver from the log.

## 16. Data, retention and privacy

Settings → Data: how long clicks, message logs, audit trail, webhook deliveries, automation runs, notifications and lead contact details are kept. Financial records are never deleted. Export the whole workspace from the same card. Affiliates can request erasure from their portal; carry it out from their page once nothing is owed.

## 17. The affiliate portal

Affiliates sign in at `/login` and see: **Home** (earnings, clicks, recent sales, campaigns, quick actions), **Offers** they can promote with their commission, **Links & Codes**, **Assets**, **Campaigns**, **Conversions**, **Leads**, **Earnings** (statement, printable), **Payouts** (method, Stripe Connect onboarding), **Disputes**, **Notifications**, **Profile** (details, text notifications, password, data requests, terms accepted).

## 18. Platform admin

Sign in with the platform admin account (created from the environment on first boot) and you land on `/admin`: workspaces with usage, plan and custom limits, suspend, close (purged after the grace period) or reactivate, the operations panel (queue, webhooks, messages, backups, retention), dead jobs with retry.

## 19. Operating checklist

Weekly: review applications, open disputes and pending leads (Home → Needs attention); create payout batches; check the delivery log for failed sends.

Monthly: read Analytics with the previous-period comparison; review automation runs; confirm backups are recent on the admin overview.

When something looks wrong: the conversion page shows attribution history and the audit trail; the affiliate page shows the ledger; the Messages delivery log shows what was sent; every API error carries a request id you can find in the logs.

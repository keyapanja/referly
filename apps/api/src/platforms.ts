import { installSnippet } from "./snippet";
import { WORDPRESS_PLUGIN_PATH } from "./wordpress";

/**
 * Copy-and-paste install instructions per website platform (TRK-09). Merchants overwhelmingly
 * run one of a handful of site builders, and the difference that matters to them is not the
 * snippet (it is the same everywhere) but *where it goes* and how the thank-you page reads the
 * order. Everything here is rendered on the tracking page with the workspace's real site key
 * already substituted, so a merchant copies rather than assembles.
 */
export interface PlatformSnippet {
  /** Heading above the code block. */
  title: string;
  /** Where in the platform this block goes, as a click path. */
  steps: string[];
  language: string;
  code: string;
  note?: string;
}

/** A platform where a plugin replaces the pasting: install it, connect it, done. */
export interface PlatformPlugin {
  downloadUrl: string;
  /** What the plugin takes care of, in the merchant's words. */
  covers: string[];
  steps: string[];
}

/**
 * A shop or payment processor that reports orders through its own webhooks: the merchant points
 * them at Referly and pastes the signing secret. The connect form is built from `fields`.
 */
export interface PlatformOrderSource {
  provider: "shopify" | "stripe";
  /** What connecting it takes care of, in the merchant's words. */
  covers: string[];
  steps: string[];
  fields: { key: string; label: string; help: string; secret: boolean; required: boolean; placeholder?: string }[];
  /** Code the merchant adds so the click token reaches the processor, where that is needed. */
  passing?: PlatformSnippet[];
}

export interface PlatformGuide {
  id: string;
  name: string;
  /** One line naming the place the tracking code lives on this platform. */
  summary: string;
  install: PlatformSnippet;
  /** Reporting the order from the confirmation page. Absent where the platform cannot do it, or a plugin does it; a fallback where webhooks do it. */
  order?: PlatformSnippet;
  /** Where a plugin does the whole job, `install` becomes the fallback for sites that cannot install it. */
  plugin?: PlatformPlugin;
  /** Where the platform's own webhooks report orders, `order` becomes the fallback for merchants who cannot use them. */
  orderSource?: PlatformOrderSource;
}

export const PLATFORM_IDS = ["custom", "wordpress", "shopify", "stripe", "webflow", "wix-squarespace", "gtm", "react"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export function platformGuides(baseUrl: string, siteKey: string, opts: { consentMode?: "off" | "wait" } = {}): PlatformGuide[] {
  const base = baseUrl.replace(/\/$/, "");
  const consentAttr = opts.consentMode === "wait" ? ` data-consent="wait"` : "";
  const tag = installSnippet(base, siteKey, { consentMode: opts.consentMode });

  const guides: PlatformGuide[] = [
    {
      id: "custom",
      name: "Custom website",
      summary: "Paste it in the shared page template, just before </head>.",
      install: {
        title: "Every page",
        steps: ["Open the layout or header template every page includes.", "Paste this immediately before the closing </head> tag.", "Deploy, then load any page of your site."],
        language: "html",
        code: tag,
      },
      order: {
        title: "Order confirmation page",
        steps: ["On the page shown after a successful payment, add this below the tracking code.", "Replace the three values with the real order details your template already has."],
        language: "html",
        code: `<script>
  referly('convert', {
    orderId: 'ORDER-1001',        // your order reference, used to avoid double counting
    amount: 129.00,               // the order total
    currency: 'USD',
    email: 'buyer@example.com'    // optional, stored only as a hash
  });
</script>`,
        note: "Print the real values from your template rather than hard-coding them. If your checkout can call our API from the server instead, prefer that: it cannot be tampered with in the browser.",
      },
    },
    {
      id: "wordpress",
      name: "WordPress",
      summary: "Install the Referly plugin and paste one key. No code to paste.",
      plugin: {
        downloadUrl: `${base}${WORDPRESS_PLUGIN_PATH}`,
        covers: [
          "Adds the tracking code to every page, FunnelKit and other page-builder pages included.",
          "Reports paid WooCommerce orders that came through an affiliate, from your server, so a closed tab or an abandoned upsell never loses a sale. Other orders are never sent.",
          "Sends refunds you make in WooCommerce, so the commission is reduced or reversed automatically.",
        ],
        steps: [
          "Download the plugin with the button below.",
          "In WordPress, open Plugins, then Add New Plugin, then Upload Plugin. Choose the file, click Install Now, then Activate.",
          "Click Create connection key below. In WordPress, open Settings, then Referly, paste the key, and click Connect.",
          "Open your site in a private window. The status at the top of this page turns to Receiving within a few seconds.",
        ],
      },
      install: {
        title: "Paste the code instead",
        steps: [
          "Only if you cannot install plugins. Install the free WPCode plugin, then Code Snippets, Header & Footer, and paste this into Header.",
          "Or paste it into header.php of a child theme, before </head>.",
          "This covers tracking only: without the plugin, WooCommerce orders are not reported automatically.",
        ],
        language: "html",
        code: tag,
      },
    },
    {
      id: "shopify",
      name: "Shopify",
      summary: "theme.liquid for tracking; Shopify's own webhooks for orders.",
      install: {
        title: "Every page",
        steps: ["Online Store, Themes, then the three-dot menu, Edit code.", "Open Layout, theme.liquid.", "Paste this immediately before </head> and save.", "The code also notes the click on the customer's cart, so the order Shopify reports carries it."],
        language: "html",
        code: tag,
      },
      orderSource: {
        provider: "shopify",
        covers: [
          "Records every paid order that came through an affiliate, from Shopify's servers, so nothing depends on the customer reaching the thank-you page.",
          "Reads the discount code on the order, so an affiliate's code attributes the sale even without a link click.",
          "Refunds and cancellations you make in Shopify reduce, reverse or void the commission by themselves.",
        ],
        steps: [
          "In Shopify, open Settings, then Notifications, then Webhooks (at the bottom of the page).",
          "Click Create webhook. Event: Order payment. Format: JSON. URL: the webhook address below. Save.",
          "Create two more with the same address: Refund create, and Order cancellation.",
          "Copy the signing secret shown under the list (\"All your webhooks will be signed with…\") into the form below and click Connect.",
          "Place a test order through an affiliate link: it shows under Recent events within a few seconds.",
        ],
        fields: [
          { key: "webhookSecret", label: "Webhook signing secret", help: "Shown under Settings, Notifications, Webhooks: \"All your webhooks will be signed with…\"", secret: true, required: true },
          { key: "shopDomain", label: "Store domain (optional)", help: "When set, events from any other store are refused.", secret: false, required: false, placeholder: "my-store.myshopify.com" },
        ],
      },
      order: {
        title: "Order status page",
        steps: ["Settings, Checkout, then Order status page additional scripts.", "Paste this. Shopify fills in the order values through Liquid, so nothing needs editing."],
        language: "html",
        code: `${tag}
<script>
  referly('convert', {
    orderId: {{ checkout.order_name | json }},
    amountMinor: {{ checkout.total_price }},
    currency: {{ checkout.currency | json }},
    email: {{ checkout.email | json }}{% if checkout.discount_applications.size > 0 %},
    couponCode: {{ checkout.discount_applications.first.title | json }}{% endif %}
  });
</script>`,
        note: "The tracking code is repeated here because the order status page is served outside your theme. amountMinor is Shopify's own cents value, so nothing is lost to rounding.",
      },
    },
    {
      id: "stripe",
      name: "Stripe Checkout or Payment Links",
      summary: "Tracking code on your site; Stripe's own webhooks for payments.",
      install: {
        title: "Every page",
        steps: [
          "Paste this immediately before </head> on every page of the site that leads to your Stripe checkout. If the site is built on WordPress, Webflow or another builder, do this step from that tab and come back here for payments.",
          "Payment Links on those pages carry the click token by themselves once the code is in place; Checkout Sessions you create on your server pass it in one line, shown below.",
        ],
        language: "html",
        code: tag,
      },
      orderSource: {
        provider: "stripe",
        covers: [
          "Records every successful Checkout Session or payment that came through an affiliate, from Stripe's servers.",
          "Payment Links on your pages pick up the click token automatically; Checkout Sessions you create on your server pass it in one line.",
          "Refunds you make in Stripe reduce or reverse the commission by themselves.",
          "With a restricted key, a promotion code the customer typed attributes the sale to the affiliate whose code it is.",
        ],
        steps: [
          "In the Stripe dashboard, open Developers, then Webhooks, then Add destination (older dashboards: Add endpoint).",
          "Endpoint URL: the webhook address below. Events: checkout.session.completed, checkout.session.async_payment_succeeded, payment_intent.succeeded and charge.refunded. Save.",
          "Open the endpoint, click Reveal under Signing secret, and paste it below.",
          "Optional: under Developers, API keys, create a restricted key with read access to Promotion codes and Coupons and paste it too, so promotion codes attribute sales.",
          "Click Connect, then make a test payment through an affiliate link: it shows under Recent events.",
        ],
        fields: [
          { key: "webhookSecret", label: "Webhook signing secret", help: "Starts with whsec_. Shown on the endpoint under Signing secret, Reveal.", secret: true, required: true, placeholder: "whsec_…" },
          { key: "secretKey", label: "Restricted key (optional)", help: "Starts with rk_live_. Only needed for promotion-code attribution; read access to Promotion codes and Coupons is enough.", secret: true, required: false, placeholder: "rk_live_…" },
        ],
        passing: [
          {
            title: "Checkout Sessions created on your server",
            steps: ["Where you create the session, pass the click token and visitor id from the snippet's first-party cookies. Node shown; they are ordinary cookies in any language."],
            language: "js",
            code: `// referly_ref and referly_vid are first-party cookies the tracking code keeps for affiliate visitors.
const session = await stripe.checkout.sessions.create({
  mode: "payment",
  line_items: [{ price: "price_123", quantity: 1 }],
  success_url: "https://example.com/thanks",
  cancel_url: "https://example.com/cart",
  client_reference_id: req.cookies.referly_ref || undefined,
  metadata: { referly_ref: req.cookies.referly_ref || "", referly_vid: req.cookies.referly_vid || "" },
});`,
            note: "Either client_reference_id or metadata.referly_ref is enough; sending both costs nothing. Custom Payment Element flows put the same two keys in the PaymentIntent's metadata.",
          },
          {
            title: "Payment Links",
            steps: ["Nothing to do. For visitors who came through an affiliate link, the tracking code appends the click token to every buy.stripe.com link on the page."],
            language: "html",
            code: `<a href="https://buy.stripe.com/xxxx">Buy now</a>
<!-- an affiliate visitor's click goes to …?client_reference_id=<click token> -->`,
          },
        ],
      },
    },
    {
      id: "webflow",
      name: "Webflow",
      summary: "Project settings, Custom code, Head code.",
      install: {
        title: "Every page",
        steps: ["Project settings, Custom code, Head code.", "Paste this into Head code and save.", "Publish the site: custom code does not run on the Designer preview."],
        language: "html",
        code: tag,
      },
      order: {
        title: "Order confirmation page (Ecommerce)",
        steps: ["Open the Order Confirmation page settings, then Before </body> tag.", "Paste this and publish."],
        language: "html",
        code: `<script>
  // Webflow exposes the order on the confirmation page.
  (function () {
    var order = window.Webflow && window.Webflow.commerce && window.Webflow.commerce.order;
    if (!order) return;
    referly('convert', {
      orderId: order.orderId,
      amount: Number(order.total),
      currency: order.currency
    });
  })();
</script>`,
        note: "If your Webflow plan does not expose the order object, print the order number and total into the page from the confirmation template and pass those instead.",
      },
    },
    {
      id: "wix-squarespace",
      name: "Wix or Squarespace",
      summary: "The site-wide custom code setting in each builder.",
      install: {
        title: "Every page",
        steps: [
          "Wix: Settings, Custom code, Add code to site, place it in the Head, on all pages.",
          "Squarespace: Website, Website tools, Code injection, Header.",
          "Save and publish, then load your live site rather than the editor preview.",
        ],
        language: "html",
        code: tag,
      },
    },
    {
      id: "gtm",
      name: "Google Tag Manager",
      summary: "A Custom HTML tag firing on All Pages.",
      install: {
        title: "Custom HTML tag",
        steps: ["Tags, New, Tag configuration, Custom HTML.", "Paste this as the HTML.", "Triggering: All Pages. Save and publish the container."],
        language: "html",
        code: tag,
      },
      order: {
        title: "Purchase tag",
        steps: ["A second Custom HTML tag, triggered on your purchase event.", "Swap the data layer variable names for the ones your site pushes."],
        language: "html",
        code: `<script>
  referly('convert', {
    orderId: {{ Transaction ID }},
    amount: {{ Transaction Total }},
    currency: {{ Transaction Currency }}
  });
</script>`,
        note: "Those double-brace names are Tag Manager variables, not ours. Set the tag to fire after the tracking tag on the same page.",
      },
    },
    {
      id: "react",
      name: "React, Next.js or a single-page app",
      summary: "Once in the HTML document; route changes are tracked for you.",
      install: {
        title: "Next.js (app router)",
        steps: ["Add this to app/layout.tsx inside the <html> element.", "One installation covers every route: the snippet follows client-side navigation by itself."],
        language: "tsx",
        code: `import Script from "next/script";

// ...inside your root layout's <body>
<Script id="referly-stub" strategy="beforeInteractive">
  {\`window.referly=window.referly||function(){(window.referly.q=window.referly.q||[]).push(arguments)};\`}
</Script>
<Script src="${base}/referly.js" data-site="${siteKey}"${consentAttr} strategy="afterInteractive" />`,
        note: "Vite, Create React App, Vue or plain single-page apps: paste the plain HTML version into index.html instead. Do not call it on every route change; the snippet already does that.",
      },
      order: {
        title: "After a successful checkout",
        steps: ["Call this once, where your app confirms the order."],
        language: "ts",
        code: `declare global {
  interface Window {
    referly: (command: string, ...args: unknown[]) => unknown;
  }
}

await window.referly("convert", {
  orderId: order.id,
  amount: order.total,
  currency: order.currency,
  email: order.email,
});`,
      },
    },
  ];
  return guides;
}

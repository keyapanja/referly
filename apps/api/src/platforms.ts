import { installSnippet } from "./snippet";

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

export interface PlatformGuide {
  id: string;
  name: string;
  /** One line naming the place the tracking code lives on this platform. */
  summary: string;
  install: PlatformSnippet;
  /** Reporting the order from the confirmation page. Absent where the platform cannot do it. */
  order?: PlatformSnippet;
}

export const PLATFORM_IDS = ["custom", "wordpress", "shopify", "webflow", "wix-squarespace", "gtm", "react"] as const;
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
      summary: "A header-scripts plugin, or header.php in your theme.",
      install: {
        title: "Every page",
        steps: [
          "Easiest: install the free WPCode plugin, then Code Snippets, Header & Footer, and paste this into Header.",
          "Or, in the theme editor, open header.php and paste it before </head>. Use a child theme, or a theme update will wipe it.",
          "Save, then open your site in a private window.",
        ],
        language: "html",
        code: tag,
      },
      order: {
        title: "WooCommerce order confirmation",
        steps: ["Add this to your child theme's functions.php, or as a PHP snippet in WPCode.", "It runs on the thank-you page and fills in the real order values."],
        language: "php",
        code: `add_action('woocommerce_thankyou', function ($order_id) {
  $order = wc_get_order($order_id);
  if (!$order) {
    return;
  }
  ?>
  <script>
    referly('convert', {
      orderId: <?php echo json_encode($order->get_order_number()); ?>,
      amount: <?php echo json_encode((float) $order->get_total()); ?>,
      currency: <?php echo json_encode($order->get_currency()); ?>,
      email: <?php echo json_encode($order->get_billing_email()); ?>
    });
  </script>
  <?php
});`,
        note: "Without WooCommerce, put the plain JavaScript version on whatever page confirms a purchase.",
      },
    },
    {
      id: "shopify",
      name: "Shopify",
      summary: "theme.liquid for tracking, checkout settings for orders.",
      install: {
        title: "Every page",
        steps: ["Online Store, Themes, then the three-dot menu, Edit code.", "Open Layout, theme.liquid.", "Paste this immediately before </head> and save."],
        language: "html",
        code: tag,
      },
      order: {
        title: "Order status page",
        steps: ["Settings, Checkout, then Order status page additional scripts.", "Paste this. Shopify fills in the order values through Liquid, so nothing needs editing."],
        language: "html",
        code: `${tag}
<script>
  referly('convert', {
    orderId: {{ checkout.order_number | json }},
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

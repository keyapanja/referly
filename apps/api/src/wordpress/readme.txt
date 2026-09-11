=== Referly ===
Tags: affiliate, referral, woocommerce, funnelkit, tracking
Requires at least: 6.0
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connects your site to Referly: the tracking code on every page, and paid WooCommerce orders reported from your server.

== Description ==

Referly tracks which affiliate sent each customer and pays the commission. This plugin does the website part for you:

* Adds the Referly tracking code to every page, including FunnelKit and other page-builder pages.
* Reports each paid WooCommerce order to Referly from your server, with the affiliate click captured at checkout. A customer who closes the tab at an upsell or during a payment redirect is still counted.
* Sends refunds you make in WooCommerce, so the commission is reduced or reversed automatically.
* Follows the settings you choose in Referly, such as waiting for cookie consent.

There is nothing to paste into your theme, checkout or thank-you page.

== Installation ==

1. In WordPress, open Plugins, then Add New Plugin, then Upload Plugin. Choose referly.zip, click Install Now, then Activate.
2. In Referly, open Website tracking, choose WordPress, and click Create connection key.
3. In WordPress, open Settings, then Referly. Paste the key and click Connect.

== Frequently Asked Questions ==

= I pasted Referly code into my theme or a snippets plugin before. =

Remove it. The plugin does the same job, and the settings page warns you while the old code is still active.

= Does it work with FunnelKit? =

Yes. FunnelKit checkouts create normal WooCommerce orders, and the plugin reports them once WooCommerce marks them paid, whether or not the customer reaches the thank-you page.

= Where do I see problems? =

On Settings, Referly, in the order's notes, and in WooCommerce, Status, Logs, under the source "referly".

= I use a caching or optimisation plugin. =

Exclude referly.js from any "delay JavaScript" feature. Otherwise visitors who leave without touching the page are not recorded.

== Changelog ==

= 1.0.0 =
* First release: tracking code, WooCommerce order and refund reporting, one-paste connection.

<?php
/**
 * Plugin Name:       Referly
 * Description:       Connects this site to Referly. Adds the tracking code to every page and reports paid WooCommerce orders, FunnelKit checkouts included, with refunds following automatically.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Referly
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * WC requires at least: 7.0
 */

defined( 'ABSPATH' ) || exit;

/**
 * Everything lives in one class so nothing here can collide with Referly code pasted by hand
 * from earlier instructions. The order meta keys and the `woocommerce` source match that code,
 * so while both run an order is still queued once and reported once.
 */
final class Referly_Connector {

	const OPTION      = 'referly_connection';
	const LAST_REPORT = 'referly_last_report';
	const REFRESH     = 'referly_refresh_connection';
	const REPORT      = 'referly_report_order';
	const PAGE        = 'referly';

	public static function boot() {
		add_action( 'wp_head', array( __CLASS__, 'print_tracking_code' ), 1 );
		add_action( self::REFRESH, array( __CLASS__, 'refresh_connection' ) );

		add_action( 'admin_menu', array( __CLASS__, 'add_settings_page' ) );
		add_action( 'admin_post_referly_connect', array( __CLASS__, 'handle_connect' ) );
		add_action( 'admin_post_referly_refresh', array( __CLASS__, 'handle_refresh' ) );
		add_action( 'admin_post_referly_disconnect', array( __CLASS__, 'handle_disconnect' ) );
		add_action( 'admin_notices', array( __CLASS__, 'nudge_to_connect' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( __CLASS__, 'settings_link' ) );

		add_action( 'before_woocommerce_init', array( __CLASS__, 'declare_hpos_support' ) );
		add_action( 'woocommerce_checkout_create_order', array( __CLASS__, 'capture_visit' ) );
		add_action( 'woocommerce_store_api_checkout_update_order_meta', array( __CLASS__, 'capture_visit_and_save' ) );
		add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'queue_paid_order' ), 10, 4 );
		add_action( self::REPORT, array( __CLASS__, 'report_order' ), 10, 2 );
		add_action( 'woocommerce_order_refunded', array( __CLASS__, 'report_refund' ), 10, 2 );
	}

	/** The saved connection, or null while the plugin is not connected. */
	public static function connection() {
		$c = get_option( self::OPTION );
		return ( is_array( $c ) && ! empty( $c['api'] ) && ! empty( $c['key'] ) ) ? $c : null;
	}

	// ---------------------------------------------------------------------
	// Tracking code
	// ---------------------------------------------------------------------

	public static function print_tracking_code() {
		$c = self::connection();
		if ( ! $c || empty( $c['tracking_enabled'] ) || empty( $c['script_url'] ) || ! preg_match( '/^site_[A-Za-z0-9]{24}$/', (string) ( $c['site_key'] ?? '' ) ) ) {
			return;
		}
		$consent = ( 'wait' === ( $c['consent_mode'] ?? '' ) ) ? ' data-consent="wait"' : '';
		echo '<script data-cfasync="false">window.referly=window.referly||function(){(window.referly.q=window.referly.q||[]).push(arguments)};</script>' . "\n";
		echo '<script async data-cfasync="false" src="' . esc_url( $c['script_url'] ) . '" data-site="' . esc_attr( $c['site_key'] ) . '" data-api="' . esc_url( $c['api'] ) . '"' . $consent . "></script>\n";
		// Pick up changes made in Referly, such as a rotated site key or consent mode, twice a day and off the page view.
		if ( time() - (int) ( $c['checked_at'] ?? 0 ) > 12 * HOUR_IN_SECONDS && ! wp_next_scheduled( self::REFRESH ) ) {
			wp_schedule_single_event( time(), self::REFRESH );
		}
	}

	/** Ask Referly what this key belongs to. Returns the fields to store, or a WP_Error. */
	public static function fetch_connection( $api, $key ) {
		$res = wp_remote_get( $api . '/v1/connection', array( 'timeout' => 15, 'headers' => array( 'Authorization' => 'Bearer ' . $key ) ) );
		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'referly_unreachable', 'Could not reach Referly: ' . $res->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$body = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( 401 === $code ) {
			return new WP_Error( 'referly_key', 'Referly did not accept this key. It may have been revoked: create a new connection key and connect again.' );
		}
		if ( 403 === $code ) {
			return new WP_Error( 'referly_key', 'This key cannot report orders. Create a connection key on the Website tracking page in Referly.' );
		}
		if ( 200 !== $code || ! is_array( $body ) ) {
			return new WP_Error( 'referly_answer', 'Referly answered with status ' . $code . '.' );
		}
		$tracking = ( isset( $body['tracking'] ) && is_array( $body['tracking'] ) ) ? $body['tracking'] : array();
		return array(
			'workspace'        => sanitize_text_field( (string) ( $body['workspace']['name'] ?? '' ) ),
			'tracking_enabled' => ! empty( $tracking['enabled'] ),
			'site_key'         => sanitize_text_field( (string) ( $tracking['siteKey'] ?? '' ) ),
			'script_url'       => esc_url_raw( (string) ( $tracking['scriptUrl'] ?? '' ) ),
			'consent_mode'     => ( 'wait' === ( $tracking['consentMode'] ?? '' ) ) ? 'wait' : 'off',
			'checked_at'       => time(),
		);
	}

	/** Re-read the settings from Referly. Runs from WP-Cron and from the Refresh button. */
	public static function refresh_connection() {
		$c = self::connection();
		if ( ! $c ) {
			return new WP_Error( 'referly_not_connected', 'Referly is not connected.' );
		}
		$fresh = self::fetch_connection( $c['api'], $c['key'] );
		if ( is_wp_error( $fresh ) ) {
			// Keep the last known settings, so the tracking code stays on the pages, and try again later.
			$c['checked_at'] = time();
			$c['error']      = $fresh->get_error_message();
			update_option( self::OPTION, $c );
			return $fresh;
		}
		unset( $c['error'] );
		update_option( self::OPTION, array_merge( $c, $fresh ) );
		return true;
	}

	/** A connection key is "rfly1_" and base64url JSON holding the API address and the key, so the merchant pastes one thing. */
	public static function parse_connection_key( $raw ) {
		$invalid = new WP_Error( 'referly_key', 'That is not a Referly connection key. Copy it again from the Website tracking page in Referly.' );
		if ( ! preg_match( '/^rfly1_([A-Za-z0-9_-]+)$/', (string) $raw, $m ) ) {
			return $invalid;
		}
		$b64  = strtr( $m[1], '-_', '+/' );
		$json = base64_decode( str_pad( $b64, (int) ( ceil( strlen( $b64 ) / 4 ) * 4 ), '=' ), true );
		$data = is_string( $json ) ? json_decode( $json, true ) : null;
		if ( ! is_array( $data ) || empty( $data['api'] ) || empty( $data['key'] ) || ! preg_match( '/^rk_live_[A-Za-z0-9]+$/', (string) $data['key'] ) ) {
			return $invalid;
		}
		$api = esc_url_raw( untrailingslashit( (string) $data['api'] ), array( 'https', 'http' ) );
		return $api ? array( 'api' => $api, 'key' => (string) $data['key'] ) : $invalid;
	}

	// ---------------------------------------------------------------------
	// Settings page
	// ---------------------------------------------------------------------

	public static function add_settings_page() {
		add_options_page( 'Referly', 'Referly', 'manage_options', self::PAGE, array( __CLASS__, 'render_settings' ) );
	}

	public static function settings_link( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::page_url() ) . '">Settings</a>' );
		return $links;
	}

	private static function page_url() {
		return admin_url( 'options-general.php?page=' . self::PAGE );
	}

	public static function nudge_to_connect() {
		if ( self::connection() || ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen || ! in_array( $screen->id, array( 'dashboard', 'plugins' ), true ) ) {
			return;
		}
		echo '<div class="notice notice-warning"><p>Referly is installed but not connected yet. <a href="' . esc_url( self::page_url() ) . '">Connect it</a></p></div>';
	}

	public static function render_settings() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$c    = self::connection();
		$note = get_transient( 'referly_notice_' . get_current_user_id() );
		if ( $note ) {
			delete_transient( 'referly_notice_' . get_current_user_id() );
		}
		echo '<div class="wrap"><h1>Referly</h1>';
		if ( is_array( $note ) ) {
			echo '<div class="notice notice-' . ( 'error' === $note['type'] ? 'error' : 'success' ) . '"><p>' . esc_html( $note['message'] ) . '</p></div>';
		}
		if ( function_exists( 'referly_send_order' ) ) {
			echo '<div class="notice notice-warning"><p>Referly code you added by hand is still active, in your theme, a must-use plugin or a code snippet. Remove it: this plugin now does the same job.</p></div>';
		}
		if ( $c ) {
			self::render_status( $c );
		} else {
			self::render_connect_form();
		}
		echo '</div>';
	}

	private static function render_connect_form() {
		?>
		<p>Connect this site to your Referly workspace. In Referly, open <strong>Website tracking</strong>, choose <strong>WordPress</strong>, and click <strong>Create connection key</strong>. Paste the key here.</p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="referly_connect">
			<?php wp_nonce_field( 'referly_connect' ); ?>
			<p><label for="referly_connection_key"><strong>Connection key</strong></label></p>
			<p><input type="text" id="referly_connection_key" name="referly_connection_key" class="large-text code" autocomplete="off" spellcheck="false" required></p>
			<?php submit_button( 'Connect' ); ?>
		</form>
		<?php
	}

	private static function render_status( $c ) {
		$last      = get_option( self::LAST_REPORT );
		$workspace = ! empty( $c['workspace'] ) ? $c['workspace'] : 'Connected';
		$rows      = array(
			'Workspace'     => esc_html( $workspace ) . '<br><span class="description">Key ' . esc_html( substr( (string) $c['key'], 0, 12 ) ) . '&hellip;, checked ' . esc_html( self::when( $c['checked_at'] ?? 0 ) ) . '</span>',
			'Tracking code' => ! empty( $c['tracking_enabled'] )
				? esc_html( 'On every page' . ( 'wait' === ( $c['consent_mode'] ?? '' ) ? ', waiting for cookie consent.' : '.' ) )
				: esc_html( 'Off. Turn on website tracking in Referly, then click Refresh below.' ),
			'Orders'        => class_exists( 'WooCommerce' )
				? esc_html( 'Paid WooCommerce orders are reported automatically, and refunds follow. Nothing goes on your checkout or thank-you page.' )
				: esc_html( 'WooCommerce is not active, so only the tracking code runs.' ),
			'Last order'    => is_array( $last )
				? esc_html( ( ! empty( $last['ok'] ) ? 'Order ' : 'Problem with order ' ) . ( $last['order'] ?? '' ) . ', ' . self::when( $last['at'] ?? 0 ) . '. ' . ( $last['message'] ?? '' ) )
				: esc_html( 'None reported yet.' ),
		);
		if ( ! empty( $c['error'] ) ) {
			echo '<div class="notice notice-warning inline"><p>' . esc_html( $c['error'] ) . '</p></div>';
		}
		echo '<table class="form-table" role="presentation"><tbody>';
		foreach ( $rows as $label => $html ) {
			// Each value above is escaped where it is built.
			echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td>' . $html . '</td></tr>';
		}
		echo '</tbody></table>';
		?>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;margin-right:8px">
			<input type="hidden" name="action" value="referly_refresh">
			<?php wp_nonce_field( 'referly_refresh' ); ?>
			<?php submit_button( 'Refresh from Referly', 'secondary', 'submit', false ); ?>
		</form>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block" onsubmit="return confirm('Disconnect Referly? The tracking code comes off your pages and orders stop being reported.');">
			<input type="hidden" name="action" value="referly_disconnect">
			<?php wp_nonce_field( 'referly_disconnect' ); ?>
			<?php submit_button( 'Disconnect', 'delete', 'submit', false ); ?>
		</form>
		<?php
	}

	private static function when( $timestamp ) {
		return $timestamp ? wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), (int) $timestamp ) : 'never';
	}

	public static function handle_connect() {
		self::guard( 'referly_connect' );
		$raw    = isset( $_POST['referly_connection_key'] ) ? trim( sanitize_text_field( wp_unslash( $_POST['referly_connection_key'] ) ) ) : '';
		$parsed = self::parse_connection_key( $raw );
		if ( is_wp_error( $parsed ) ) {
			self::done( 'error', $parsed->get_error_message() );
		}
		$fields = self::fetch_connection( $parsed['api'], $parsed['key'] );
		if ( is_wp_error( $fields ) ) {
			self::done( 'error', $fields->get_error_message() );
		}
		// Orders placed before this moment stay out of Referly.
		$fields['connected_at'] = time();
		update_option( self::OPTION, array_merge( $parsed, $fields ) );
		$workspace = ! empty( $fields['workspace'] ) ? $fields['workspace'] : 'Referly';
		self::done( 'success', 'Connected to ' . $workspace . '. The tracking code is on your pages' . ( class_exists( 'WooCommerce' ) ? ', and paid orders are reported from now on.' : '.' ) );
	}

	public static function handle_refresh() {
		self::guard( 'referly_refresh' );
		$result = self::refresh_connection();
		if ( is_wp_error( $result ) ) {
			self::done( 'error', $result->get_error_message() );
		}
		self::done( 'success', 'Settings refreshed from Referly.' );
	}

	public static function handle_disconnect() {
		self::guard( 'referly_disconnect' );
		delete_option( self::OPTION );
		wp_clear_scheduled_hook( self::REFRESH );
		self::done( 'success', 'Disconnected. The tracking code is off your pages and orders are no longer reported.' );
	}

	private static function guard( $action ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'You are not allowed to change Referly settings.' );
		}
		check_admin_referer( $action );
	}

	private static function done( $type, $message ) {
		set_transient( 'referly_notice_' . get_current_user_id(), array( 'type' => $type, 'message' => $message ), 60 );
		wp_safe_redirect( self::page_url() );
		exit;
	}

	// ---------------------------------------------------------------------
	// WooCommerce orders
	// ---------------------------------------------------------------------

	public static function declare_hpos_support() {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		}
	}

	/** At checkout: keep the affiliate click and visitor id that the tracking code stored in cookies on this site. */
	public static function capture_visit( $order ) {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		foreach ( array( 'referly_ref' => '/^[A-Za-z0-9_-]{6,64}$/', 'referly_vid' => '/^[A-Za-z0-9_-]{8,64}$/' ) as $cookie => $pattern ) {
			$value = isset( $_COOKIE[ $cookie ] ) ? wp_unslash( $_COOKIE[ $cookie ] ) : '';
			if ( is_string( $value ) && preg_match( $pattern, $value ) && ! $order->get_meta( '_' . $cookie ) ) {
				$order->update_meta_data( '_' . $cookie, $value );
			}
		}
	}

	public static function capture_visit_and_save( $order ) {
		self::capture_visit( $order );
		if ( $order instanceof WC_Order ) {
			$order->save();
		}
	}

	/** Once WooCommerce marks an order paid, queue its report, so the checkout is never slowed down. */
	public static function queue_paid_order( $order_id, $from, $to, $order ) {
		$c = self::connection();
		if ( ! $c || ! $order instanceof WC_Order || ! in_array( $to, array( 'processing', 'completed' ), true ) || $order->get_meta( '_referly_queued' ) ) {
			return;
		}
		$created = $order->get_date_created();
		if ( $created && ! empty( $c['connected_at'] ) && $created->getTimestamp() < (int) $c['connected_at'] ) {
			return;
		}
		// A payment made in the customer's own browser, such as a separate upsell order, still carries the cookies.
		self::capture_visit( $order );
		$order->update_meta_data( '_referly_queued', time() );
		$order->save_meta_data();
		WC()->queue()->add( self::REPORT, array( $order_id, 1 ), 'referly' );
	}

	public static function report_order( $order_id, $attempt = 1 ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || $order->get_meta( '_referly_conversion_id' ) ) {
			return;
		}
		$c = self::connection();
		if ( ! $c ) {
			self::record_problem( $order, 'Referly is not connected, so this order was not reported.' );
			return;
		}
		$currency = $order->get_currency();
		$total    = (float) $order->get_total();
		$net      = $total - (float) $order->get_total_tax() - (float) $order->get_shipping_total();
		$coupon   = current( $order->get_coupon_codes() );
		$email    = $order->get_billing_email();
		$paid     = $order->get_date_paid();
		$body     = array_filter(
			array(
				'source'          => 'woocommerce',
				'externalOrderId' => (string) $order->get_order_number(),
				'amountMinor'     => self::minor( $total, $currency ),
				'netAmountMinor'  => self::minor( max( 0, $net ), $currency ),
				'currency'        => $currency,
				'customerEmail'   => is_email( $email ) ? $email : null,
				'couponCode'      => ( is_string( $coupon ) && '' !== $coupon && strlen( $coupon ) <= 40 ) ? $coupon : null,
				'clickToken'      => $order->get_meta( '_referly_ref' ) ? (string) $order->get_meta( '_referly_ref' ) : null,
				'visitorId'       => $order->get_meta( '_referly_vid' ) ? (string) $order->get_meta( '_referly_vid' ) : null,
				'occurredAt'      => $paid ? $paid->format( DATE_ATOM ) : null,
			),
			function ( $value ) {
				return null !== $value;
			}
		);

		$res  = wp_remote_post( $c['api'] . '/v1/conversions', self::request( $c, $body ) );
		$code = is_wp_error( $res ) ? 0 : (int) wp_remote_retrieve_response_code( $res );
		if ( 200 === $code || 201 === $code ) {
			$data       = json_decode( wp_remote_retrieve_body( $res ), true );
			$conversion = ( is_array( $data ) && isset( $data['conversion'] ) && is_array( $data['conversion'] ) ) ? $data['conversion'] : array();
			$order->update_meta_data( '_referly_conversion_id', (string) ( $conversion['id'] ?? '' ) );
			$order->save_meta_data();
			$message = empty( $conversion['affiliateId'] ) ? 'Reported, no affiliate matched.' : 'Reported and attributed to an affiliate.';
			$order->add_order_note( 'Referly: ' . $message );
			update_option( self::LAST_REPORT, array( 'at' => time(), 'order' => $order->get_order_number(), 'ok' => true, 'message' => $message ), false );
			return;
		}
		// Referly unreachable or busy: try again with growing gaps, for about an hour in all.
		if ( ( 0 === $code || 429 === $code || $code >= 500 ) && $attempt < 6 ) {
			WC()->queue()->schedule_single( time() + 60 * ( 2 ** $attempt ), self::REPORT, array( $order_id, $attempt + 1 ), 'referly' );
			return;
		}
		$why = is_wp_error( $res ) ? $res->get_error_message() : $code . ' ' . substr( wp_remote_retrieve_body( $res ), 0, 300 );
		self::record_problem( $order, 'Not reported: ' . $why );
	}

	/** Refunds made in WooCommerce reduce or reverse the commission in Referly. */
	public static function report_refund( $order_id, $refund_id ) {
		$c      = self::connection();
		$order  = wc_get_order( $order_id );
		$refund = wc_get_order( $refund_id );
		$id     = $order ? (string) $order->get_meta( '_referly_conversion_id' ) : '';
		if ( ! $c || '' === $id || ! $refund || (float) $refund->get_amount() <= 0 ) {
			return;
		}
		$res = wp_remote_post(
			$c['api'] . '/v1/conversions/' . rawurlencode( $id ) . '/refund',
			self::request(
				$c,
				array(
					'amountMinor' => self::minor( (float) $refund->get_amount(), $order->get_currency() ),
					'reason'      => $refund->get_reason() ? $refund->get_reason() : 'Refunded in WooCommerce',
				)
			)
		);
		if ( is_wp_error( $res ) || (int) wp_remote_retrieve_response_code( $res ) >= 300 ) {
			self::record_problem( $order, 'The refund was not reported. Record it on the conversion in Referly.' );
			return;
		}
		$order->add_order_note( 'Referly: refund reported.' );
	}

	/** Shown on the settings page, as an order note, and in WooCommerce, Status, Logs, under "referly". */
	private static function record_problem( $order, $message ) {
		update_option( self::LAST_REPORT, array( 'at' => time(), 'order' => $order->get_order_number(), 'ok' => false, 'message' => $message ), false );
		$order->add_order_note( 'Referly: ' . $message );
		if ( function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->warning( 'Order ' . $order->get_id() . ': ' . $message, array( 'source' => 'referly' ) );
		}
	}

	private static function request( $c, $body ) {
		return array(
			'timeout' => 15,
			'headers' => array(
				'Authorization' => 'Bearer ' . $c['key'],
				'Content-Type'  => 'application/json',
			),
			'body'    => wp_json_encode( $body ),
		);
	}

	private static function minor( $amount, $currency ) {
		$zero_decimal = array( 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF', 'PYG', 'RWF' );
		return (int) round( $amount * ( in_array( strtoupper( (string) $currency ), $zero_decimal, true ) ? 1 : 100 ) );
	}

	public static function deactivate() {
		wp_clear_scheduled_hook( self::REFRESH );
	}

	public static function uninstall() {
		delete_option( self::OPTION );
		delete_option( self::LAST_REPORT );
		wp_clear_scheduled_hook( self::REFRESH );
	}
}

Referly_Connector::boot();
register_deactivation_hook( __FILE__, array( 'Referly_Connector', 'deactivate' ) );
register_uninstall_hook( __FILE__, array( 'Referly_Connector', 'uninstall' ) );

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getConfig } from "../config.server";
import { buildQrLink } from "../rings/qr-links.server";
import { ringRepository } from "../rings/ring-repository.server";
import { kickWritebacks, retryWritebackNow } from "../rings/runner.server";
import type { RingStatus, WritebackState } from "../rings/types";
import { buildScanUrl } from "../rings/vault-url";
import { authenticate } from "../shopify.server";

const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const config = getConfig();
  const search = new URL(request.url).searchParams.get("q") ?? "";

  const orders = await ringRepository.listOrders(session.shop, {
    search,
    limit: PAGE_SIZE,
  });
  const rings = await ringRepository.findRingsByOrderIds(orders.map((o) => o._id));

  // Anything still queued gets another chance whenever the page is opened.
  if (orders.some((order) => order.writeback === "PENDING")) kickWritebacks();

  // Everything returned here is sent to the browser. It is the Shopify admin,
  // which is where scan links are allowed to appear; nothing else is included.
  return {
    search,
    vaultHost: new URL(config.vaultBaseUrl).host,
    truncated: orders.length === PAGE_SIZE,
    orders: orders.map((order) => ({
      id: order._id,
      name: order.orderName,
      adminUrl: `shopify://admin/orders/${order._id.split("/").pop()}`,
      writeback: order.writeback,
      lastError: order.writeback === "FAILED" ? order.lastError : null,
      rings: rings
        .filter((ring) => ring.order.id === order._id)
        .map((ring) => {
          const downloadable = ring.status !== "VOID";
          return {
            id: ring._id,
            status: ring.status,
            unit: ring.order.unitIndex + 1,
            scanUrl: downloadable ? buildScanUrl(config.vaultBaseUrl, ring._id) : null,
            png: downloadable ? buildQrLink(config, ring._id, "png") : null,
            svg: downloadable ? buildQrLink(config, ring._id, "svg") : null,
          };
        }),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const orderId = String(form.get("orderId") ?? "");

  if (form.get("intent") !== "retry" || !orderId) {
    return { ok: false, message: "Unknown action" };
  }
  // Scoped to the signed-in shop: one store can never touch another's orders.
  const found = await ringRepository.requeueWriteback(session.shop, orderId);
  if (!found) return { ok: false, message: "Order not found" };

  const ok = await retryWritebackNow(orderId);
  return {
    ok,
    message: ok ? "Order updated" : "Update failed. It will be retried automatically.",
  };
};

const STATUS_TONE: Record<RingStatus, "info" | "success" | "warning" | "neutral"> = {
  UNCLAIMED: "info",
  SEALED_GIFT: "warning",
  ACTIVE_CLAIMED: "success",
  VOID: "neutral",
};

const STATUS_LABEL: Record<RingStatus, string> = {
  UNCLAIMED: "Unclaimed",
  SEALED_GIFT: "Sealed gift",
  ACTIVE_CLAIMED: "Claimed",
  VOID: "Void",
};

const WRITEBACK_BADGE: Record<
  WritebackState,
  { tone: "success" | "warning" | "critical"; label: string }
> = {
  DONE: { tone: "success", label: "On order" },
  PENDING: { tone: "warning", label: "Updating order" },
  FAILED: { tone: "critical", label: "Order update failed" },
};

export default function RingsPage() {
  const { orders, search, vaultHost, truncated } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  // Searching must stay a client-side navigation. A plain browser form would
  // reload the iframe without Shopify's embedded-app parameters and the page
  // would come back blank.
  const [, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(search);
  // Keep the box in step with the URL (for example after clicking "Rings"
  // in the nav, which clears the search).
  useEffect(() => setQuery(search), [search]);
  const runSearch = () => setSearchParams(query.trim() ? { q: query.trim() } : {});

  const retryingId = fetcher.state !== "idle" ? fetcher.formData?.get("orderId") : null;

  return (
    <s-page heading="Rings">
      <s-banner tone="info">
        QR codes point to <s-text type="strong">{vaultHost}</s-text>. Only send
        files to the engraver once this is the final production domain: an
        engraved code cannot be changed.
      </s-banner>

      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical">{fetcher.data.message}</s-banner>
      )}

      <s-section>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            runSearch();
          }}
        >
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-text-field
              label="Find an order"
              placeholder="#1001"
              value={query}
              onInput={(event) =>
                setQuery(event.currentTarget.value ?? "")
              }
            />
            <s-button onClick={runSearch}>Search</s-button>
          </s-stack>
        </form>
      </s-section>

      {orders.length === 0 && (
        <s-section heading="No rings yet">
          <s-paragraph>
            {search
              ? "No orders with rings match this search."
              : "Rings appear here when an order containing a ring product is paid."}
          </s-paragraph>
        </s-section>
      )}

      {orders.map((order) => {
        const badge = WRITEBACK_BADGE[order.writeback];
        return (
          <s-section key={order.id}>
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-heading>Order {order.name}</s-heading>
                <s-badge tone={badge.tone}>{badge.label}</s-badge>
                <s-link href={order.adminUrl} target="_top">
                  Open order
                </s-link>
                {order.writeback !== "DONE" && (
                  <s-button
                    variant="tertiary"
                    {...(retryingId === order.id ? { loading: true } : {})}
                    onClick={() =>
                      fetcher.submit(
                        { intent: "retry", orderId: order.id },
                        { method: "POST" },
                      )
                    }
                  >
                    Retry order update
                  </s-button>
                )}
              </s-stack>

              {order.lastError && (
                <s-banner tone="critical">{order.lastError}</s-banner>
              )}

              <s-table>
                <s-table-header-row>
                  <s-table-header>QR</s-table-header>
                  <s-table-header>Unit</s-table-header>
                  <s-table-header>Ring ID</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Files</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {order.rings.map((ring) => (
                    <s-table-row key={ring.id}>
                      <s-table-cell>
                        {ring.png ? (
                          <img
                            src={`${ring.png}&inline=1`}
                            alt={`QR code for ring ${ring.id}`}
                            width={72}
                            height={72}
                            loading="lazy"
                          />
                        ) : (
                          <s-text color="subdued">None</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>{ring.unit}</s-table-cell>
                      <s-table-cell>
                        <s-text type="strong">{ring.id}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={STATUS_TONE[ring.status]}>
                          {STATUS_LABEL[ring.status]}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {ring.svg && ring.png && ring.scanUrl ? (
                          <s-stack direction="inline" gap="base">
                            <s-link href={ring.svg} target="_blank">
                              SVG (engraving)
                            </s-link>
                            <s-link href={ring.png} target="_blank">
                              PNG (proof)
                            </s-link>
                            <s-link href={ring.scanUrl} target="_blank">
                              Test scan link
                            </s-link>
                          </s-stack>
                        ) : (
                          <s-text color="subdued">Not available for void rings</s-text>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-stack>
          </s-section>
        );
      })}

      {truncated && (
        <s-section>
          <s-paragraph>
            Showing the {PAGE_SIZE} most recent orders. Search by order number
            to find older ones.
          </s-paragraph>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

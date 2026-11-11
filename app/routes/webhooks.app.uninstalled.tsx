import type { ActionFunctionArgs } from "react-router";
import { mongoSessionStorage } from "../db/session-storage.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhooks can fire more than once and after the app is already gone, so
  // this is a plain idempotent delete. Rings are kept: they belong to the
  // families, not to the app installation.
  await mongoSessionStorage.deleteSessionsByShop(shop);

  return new Response();
};

import type { ActionFunctionArgs } from "react-router";
import { mongoSessionStorage } from "../db/session-storage.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current as string[];
  if (session) {
    session.scope = current.toString();
    await mongoSessionStorage.storeSession(session);
  }
  return new Response();
};

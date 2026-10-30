import { db } from "../../src/db.server.ts";

/** For the image's HEALTHCHECK: the server answers and the database does. Says nothing else. */
export function loader() {
  db().query("SELECT 1").get();
  return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
}

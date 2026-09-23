import Fastify from "fastify";
import { openDatabase } from "./database.js";

export function buildApp() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => {
    const database = openDatabase();
    database.prepare("SELECT 1").get();
    database.close();
    return { status: "ok" };
  });
  return app;
}

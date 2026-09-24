import Fastify from "fastify";
import { openDatabase } from "./database.js";
import type { Db } from "./domain/model.js";
import { installErrorHandler, registerRoutes } from "./http/routes.js";

export interface BuildAppOptions {
  db?: Db;
  /** 可注入的时钟（测试固定时间用），默认系统时间 */
  clock?: () => Date;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase();
  const clock = options.clock ?? (() => new Date());

  installErrorHandler(app);

  app.get("/health", async () => {
    db.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  registerRoutes(app, db, clock);

  app.addHook("onClose", async () => {
    if (ownsDb) db.close();
  });

  return app;
}

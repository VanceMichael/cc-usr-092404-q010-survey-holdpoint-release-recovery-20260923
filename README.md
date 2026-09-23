# 廊桥测绘基线仲裁库

工程以 Fastify 和 TypeScript 提供测绘基线管理的后端入口，使用 Node.js 22 的内置 SQLite API 访问 `data/bridge_baselines.sqlite3`。可通过 `DATABASE_PATH`、`HOST`、`PORT` 调整本地运行位置。

```bash
npm ci
npm run db:migrate
npm test
npm run build
npm start
```

接口、连接、迁移和启动验证分别位于 `src`、`scripts`、`migrations` 与 `test`，应用不连接远程对象存储或消息系统。

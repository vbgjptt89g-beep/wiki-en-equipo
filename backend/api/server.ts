import "dotenv/config";
import { createServer } from "node:http";
import { app, realtimeHub } from "./app.js";
import { prisma } from "../models/client.js";

const port = Number(process.env.PORT ?? 4000);
const server = createServer(app);
realtimeHub.attach(server);

server.listen(port, () => console.log(`Wiki en equipo API escuchando en http://localhost:${port}`));

async function shutdown() {
  server.close();
  await prisma.$disconnect();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

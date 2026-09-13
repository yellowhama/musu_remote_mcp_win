import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { startHttpServer } from "./http-server.js";
import { createServices } from "./mcp-server.js";
import { writeWindowsEvent } from "./windows-event-log.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const services = createServices(config);
  const running = await startHttpServer(config, services);
  const endpointUrl = config.publicUrl
    ? `${config.publicUrl}${config.endpoint}`
    : `http://${config.host}:${config.port}${config.endpoint}`;

  console.log(`cokacremote listening at ${endpointUrl}`);
  console.log(`default cwd: ${config.defaultCwd}`);
  console.log("execution mode: unrestricted host access");
  writeWindowsEvent(900, "INFORMATION", `Musu Remote MCP started on ${config.host}:${config.port}`);
  console.log(
    config.allowNoAuth && !config.authToken && !config.oauthEnabled
      ? "authentication: disabled"
      : config.oauthEnabled
        ? config.authToken
          ? "authentication: static bearer + OAuth 2.1 (DCR/PKCE)"
          : "authentication: OAuth 2.1 (DCR/PKCE)"
        : "authentication: bearer token",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`received ${signal}; shutting down`);
    try {
      await running.close();
      writeWindowsEvent(901, "INFORMATION", `Musu Remote MCP stopped after ${signal}`);
      process.exitCode = 0;
    } catch (error) {
      console.error("shutdown failed:", errorMessage(error));
      writeWindowsEvent(902, "ERROR", `Musu Remote MCP shutdown failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("cokacremote failed to start:", errorMessage(error));
  writeWindowsEvent(903, "ERROR", `Musu Remote MCP startup failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});

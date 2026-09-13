import type { McpServer } from "@modelcontextprotocol/server";

export interface ToolRegistrar {
  registerTool: McpServer["registerTool"];
}

export type ToolRegistrarFactory = (base: ToolRegistrar) => ToolRegistrar;

interface MusuToolRegistryGlobal {
  __musuToolRegistrarFactory?: ToolRegistrarFactory;
}

export function createToolRegistrar(server: McpServer): ToolRegistrar {
  const base: ToolRegistrar = {
    registerTool: server.registerTool.bind(server) as McpServer["registerTool"],
  };
  const host = globalThis as typeof globalThis & MusuToolRegistryGlobal;
  return host.__musuToolRegistrarFactory?.(base) ?? base;
}

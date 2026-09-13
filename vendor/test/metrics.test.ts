import { channel } from "node:diagnostics_channel";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { MetricsRegistry, metricRoute } from "../src/metrics.js";

describe("bounded operational metrics", () => {
  it("maps arbitrary paths to a fixed route label set", () => {
    expect(metricRoute("/mcp", "/mcp")).toBe("mcp");
    expect(metricRoute("/authorize", "/mcp")).toBe("oauth");
    expect(metricRoute("/attacker-controlled/path", "/mcp")).toBe("other");
  });

  it("records auth, queue, checkpoint, process, and disk signals", async () => {
    const metrics = new MetricsRegistry();
    try {
      metrics.rejectAuth("origin");
      metrics.observeHttp("mcp", 401, 125);
      channel("musu.remote-mcp.telemetry").publish({
        type: "checkpoint", outcome: "success", durationMs: 250, totalBytes: 4096,
      });
      channel("musu.remote-mcp.telemetry").publish({ type: "mutation_queue", pending: 3 });
      const config = loadConfig({ MCP_ALLOW_NO_AUTH: "true", MCP_DEFAULT_CWD: process.cwd() });
      const body = await metrics.render(config, {
        fileService: {} as never,
        processManager: {
          list: () => [{ running: true }, { running: false }],
        } as never,
      });
      expect(body).toContain('musu_http_requests_total{route="mcp",status_class="4xx"} 1');
      expect(body).toContain('musu_auth_rejections_total{reason="origin"} 1');
      expect(body).toContain('musu_managed_processes{state="running"} 1');
      expect(body).toContain("musu_mutation_queue_pending 3");
      expect(body).toContain('musu_checkpoints_total{outcome="success"} 1');
      expect(body).toContain("musu_checkpoint_bytes_total 4096");
      expect(body).toContain("musu_workspace_disk_free_bytes");
    } finally {
      metrics.close();
    }
  });
});

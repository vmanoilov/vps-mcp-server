#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";

// Require VPS_API_BASE from environment variables only (no fallback).
if (!process.env.VPS_API_BASE) {
  throw new Error(
    "Missing VPS_API_BASE environment variable. " +
    "Please set VPS_API_BASE to your VPS REST API URL."
  );
}

const VPS_API_BASE = process.env.VPS_API_BASE;

/**
 * Helper to call VPS REST API endpoints
 */
async function callVps(path, body) {
  const url = `${VPS_API_BASE}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {})
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const json = await res.json();
    if (json.success === false) {
      throw new Error(json.stderr || "VPS returned success=false");
    }

    return json;
  } catch (err) {
    throw new Error(`Error calling VPS API at ${url}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Create MCP Server
// ---------------------------------------------------------------------

const server = new McpServer({
  name: "vps-remote",
  version: "1.0.0"
});

// 1) Run shell command
server.tool(
  "vps_run_command",
  "Run a shell command on your VPS via /run.",
  { cmd: z.string().min(1) },
  async ({ cmd }) => {
    const result = await callVps("/run", { cmd });
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";

    const text =
      `Command: ${cmd}\n\n` +
      `--- STDOUT ---\n${stdout || "[empty]"}\n\n` +
      `--- STDERR ---\n${stderr || "[empty]"}`;

    return { content: [{ type: "text", text }] };
  }
);

// 2) Directory listing
server.tool(
  "vps_list_dir",
  "List files/directories on VPS via /ls.",
  { path: z.string().min(1) },
  async ({ path }) => {
    const result = await callVps("/ls", { path });
    const files = result.files || [];

    const lines = files.map((f) => {
      const prefix = f.type === "dir" ? "[DIR]" : "     ";
      return `${prefix}  ${f.name}`;
    });

    const text =
      `Directory listing for: ${path}\n\n` +
      (lines.length ? lines.join("\n") : "[empty]");

    return { content: [{ type: "text", text }] };
  }
);

// 3) Read file
server.tool(
  "vps_read_file",
  "Read file content from VPS via /read.",
  { path: z.string().min(1) },
  async ({ path }) => {
    const result = await callVps("/read", { path });
    const content = result.content ?? "";
    return {
      content: [{ type: "text", text: `File: ${path}\n\n${content}` }]
    };
  }
);

// 4) Write file
server.tool(
  "vps_write_file",
  "Write content to a VPS file via /write.",
  {
    path: z.string().min(1),
    content: z.string()
  },
  async ({ path, content }) => {
    const result = await callVps("/write", { path, content });
    const ok = result.success !== false;

    const stdout = result.stdout || "";
    const stderr = result.stderr || "";

    const text =
      `Write file: ${path}\n` +
      `Status: ${ok ? "success" : "failed"}\n\n` +
      (stdout ? `STDOUT:\n${stdout}\n\n` : "") +
      (stderr ? `STDERR:\n${stderr}\n` : "");

    return { content: [{ type: "text", text }] };
  }
);

// Connect via STDIO (used by mcphosting + local dev)
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("Failed to start vps-remote MCP server:", err);
  process.exit(1);
});

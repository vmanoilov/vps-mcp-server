#!/usr/bin/env node
import http from "http";
import { z } from "zod";
import fetch from "node-fetch";

// ---------------------
// ENV CHECK
// ---------------------
if (!process.env.VPS_API_BASE) {
  throw new Error("VPS_API_BASE missing. Set it via Fly secrets.");
}

const VPS_API_BASE = process.env.VPS_API_BASE;
const PORT = process.env.PORT || 8000;

// -------------------------
// TOOL DEFINITIONS
// -------------------------

async function callVps(path, body) {
  const url = `${VPS_API_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`VPS error HTTP ${res.status}: ${txt}`);
  }

  const json = await res.json();
  if (json.success === false) {
    throw new Error(json.stderr || "VPS returned success=false");
  }

  return json;
}

const tools = {
  vps_run_command: {
    description: "Run shell command via VPS API",
    schema: {
      cmd: z.string()
    },
    handler: async ({ cmd }) => {
      const r = await callVps("/run", { cmd });
      return {
        type: "text",
        text: `CMD: ${cmd}\n\nSTDOUT:\n${r.stdout || "[empty]"}\n\nSTDERR:\n${r.stderr || "[empty]"}`
      };
    }
  },

  vps_list_dir: {
    description: "List directory via VPS API",
    schema: {
      path: z.string()
    },
    handler: async ({ path }) => {
      const r = await callVps("/ls", { path });
      const lines = (r.files || [])
        .map(f => `${f.type === "dir" ? "[DIR]" : "     "}  ${f.name}`)
        .join("\n");

      return {
        type: "text",
        text: `Listing: ${path}\n\n${lines || "[empty]"}`
      };
    }
  },

  vps_read_file: {
    description: "Read file via VPS",
    schema: {
      path: z.string()
    },
    handler: async ({ path }) => {
      const r = await callVps("/read", { path });
      return {
        type: "text",
        text: `File: ${path}\n\n${r.content || ""}`
      };
    }
  },

  vps_write_file: {
    description: "Write file via VPS",
    schema: {
      path: z.string(),
      content: z.string()
    },
    handler: async ({ path, content }) => {
      const r = await callVps("/write", { path, content });
      return {
        type: "text",
        text: `Write: ${path}\nSuccess: ${r.success}\n\nSTDOUT:\n${r.stdout || ""}\nSTDERR:\n${r.stderr || ""}`
      };
    }
  }
};

// -----------------------------
// MCP HTTP SERVER LOGIC
// -----------------------------

function sendJSON(res, obj) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify(obj, null, 2));
}

function mcpResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, message) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404);
    return res.end("Not found");
  }

  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", async () => {
    try {
      const data = JSON.parse(body);
      const { id, method, params } = data;

      // INIT
      if (method === "initialize") {
        return sendJSON(
          res,
          mcpResponse(id, {
            protocolVersion: "1.0",
            serverInfo: {
              name: "vps-mcp-server",
              version: "1.0.0"
            },
            capabilities: {
              tools: {}
            }
          })
        );
      }

      // LIST TOOLS
      if (method === "tools/list") {
        const list = Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(t.schema.shape).map(([k, v]) => [
                k,
                { type: "string" }
              ])
            ),
            required: Object.keys(t.schema.shape)
          }
        }));
        return sendJSON(res, mcpResponse(id, { tools: list }));
      }

      // INVOKE TOOL
      if (method === "tools/invoke") {
        const tool = tools[params.name];
        if (!tool) {
          return sendJSON(res, mcpError(id, "Unknown tool: " + params.name));
        }

        let validated;
        try {
          validated = tool.schema.parse(params.arguments);
        } catch (e) {
          return sendJSON(res, mcpError(id, "Invalid arguments: " + e.message));
        }

        const out = await tool.handler(validated);
        return sendJSON(res, mcpResponse(id, { content: [out] }));
      }

      // UNKNOWN CALL
      return sendJSON(res, mcpError(id, "Unknown method: " + method));
    } catch (err) {
      return sendJSON(res, { jsonrpc: "2.0", error: { code: -32001, message: err.message } });
    }
  });
});

// Start listening
server.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP HTTP server running on port ${PORT} at /mcp`);
});

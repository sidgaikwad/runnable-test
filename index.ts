import { generateText, tool, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, desc, inArray, and, asc } from "drizzle-orm";
import Docker from "dockerode";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

const CONTEXT_LIMIT = 2000;
const COMPACTION_THRESHOLD = 0.7; // Compact earlier to avoid hitting limit
const KEEP_RECENT_MESSAGES = 6;
const OUTPUT_DIR = "./output";

// ============================================================================
// 2. DATABASE SCHEMA
// ============================================================================

const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  containerId: text("container_id"),
});

const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  tokenCount: integer("token_count").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  compacted: integer("compacted", { mode: "boolean" }).notNull().default(false),
});

const compactionEvents = sqliteTable("compaction_events", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  summary: text("summary").notNull(),
  compactedMessageIds: text("compacted_message_ids").notNull(),
  tokenCount: integer("token_count").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

const apiCalls = sqliteTable("api_calls", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  promptTokens: integer("prompt_tokens").notNull(),
  completionTokens: integer("completion_tokens").notNull(),
  totalTokens: integer("total_tokens").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// ============================================================================
// 3. DATABASE INITIALIZATION
// ============================================================================

const sqlite = new Database("agent.db");
const db = drizzle(sqlite);

function initDB() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      container_id TEXT
    );
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      compacted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS compaction_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      compacted_message_ids TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS api_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
  console.log("✅ Database schema initialized");
}

initDB();

// ============================================================================
// 4. DOCKER INFRASTRUCTURE
// ============================================================================

let docker: Docker;

async function initializeDocker(): Promise<Docker> {
  const connectionAttempts = [
    { name: "localhost:2375", config: { host: "localhost", port: 2375 } },
    {
      name: "host.docker.internal",
      config: { host: "host.docker.internal", port: 2375 },
    },
    { name: "Unix socket", config: { socketPath: "/var/run/docker.sock" } },
  ];

  for (const attempt of connectionAttempts) {
    if (process.platform === "win32" && attempt.name === "Unix socket")
      continue;
    try {
      const client = new Docker(attempt.config);
      await client.ping();
      console.log(`✅ Docker connected via ${attempt.name}`);
      return client;
    } catch (e) {
      /* ignore */
    }
  }
  console.error("❌ Docker connection failed.");
  process.exit(1);
}

docker = await initializeDocker();

async function createContainer(): Promise<string> {
  try {
    const container = await docker.createContainer({
      Image: "oven/bun:1-alpine",
      Cmd: ["/bin/sh", "-c", "apk add --no-cache sqlite && tail -f /dev/null"],
      WorkingDir: "/workspace",
      HostConfig: { AutoRemove: true },
    });
    await container.start();
    return container.id;
  } catch (error: any) {
    if (error.statusCode === 404) {
      console.log("Pulling image oven/bun:1-alpine...");
      await new Promise((resolve, reject) => {
        docker.pull("oven/bun:1-alpine", (err: any, stream: any) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err) =>
            err ? reject(err) : resolve(true),
          );
        });
      });
      return createContainer();
    }
    throw error;
  }
}

async function executeCommand(
  containerId: string,
  command: string,
): Promise<string> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/workspace",
  });
  const stream = await exec.start({ Detach: false, Tty: false });
  return new Promise((resolve, reject) => {
    let output = "";
    stream.on("data", (chunk: Buffer) => (output += chunk.toString()));
    stream.on("end", () =>
      resolve(output.replace(/[\x00-\x09\x0B-\x1F\x7F].{0,7}/g, "").trim()),
    );
    stream.on("error", reject);
  });
}

async function writeFile(
  containerId: string,
  path: string,
  content: string,
): Promise<void> {
  const container = docker.getContainer(containerId);
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) {
    const mkdirExec = await container.exec({ Cmd: ["mkdir", "-p", dir] });
    await mkdirExec.start({ Detach: false });
  }
  const b64Content = Buffer.from(content).toString("base64");
  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", `echo "${b64Content}" | base64 -d > ${path}`],
  });
  await exec.start({ Detach: false });
}

async function exportWorkspace(containerId: string, sessionId: string) {
  const sessionDir = path.join(OUTPUT_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`\n📦 Exporting workspace to ${sessionDir}...`);

  const fileListRaw = await executeCommand(
    containerId,
    "find . -maxdepth 2 -not -path '*/.*'",
  );
  const files = fileListRaw.split("\n").filter((f) => f && !f.endsWith("."));

  for (const file of files) {
    if (file === "." || file === "./node_modules") continue;
    try {
      const isDir =
        (await executeCommand(
          containerId,
          `[ -d "${file}" ] && echo "yes" || echo "no"`,
        )) === "yes";
      if (isDir) continue;

      const content = await executeCommand(containerId, `cat "${file}"`);
      const localPath = path.join(sessionDir, file);
      const localDir = path.dirname(localPath);

      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(localPath, content);
      console.log(`  - Saved ${file}`);
    } catch (e) {
      console.log(`  - Failed to save ${file}`);
    }
  }
}

// ============================================================================
// 5. TOKEN TRACKING - THE CORRECT WAY
// ============================================================================

async function getCurrentTokenUsage(sessionId: string): Promise<number> {
  const calls = await db
    .select()
    .from(apiCalls)
    .where(eq(apiCalls.sessionId, sessionId));

  if (calls.length === 0) return 0;

  const lastCall = calls[calls.length - 1];
  return lastCall.promptTokens;
}

// ============================================================================
// 6. CONTEXT COMPACTION
// ============================================================================

// ============================================================================
// 6. CONTEXT COMPACTION (SIMPLIFIED - 23 LINES)
// ============================================================================

async function getPreviousSummary(sessionId: string): Promise<string | null> {
  const events = await db
    .select()
    .from(compactionEvents)
    .where(eq(compactionEvents.sessionId, sessionId))
    .orderBy(desc(compactionEvents.createdAt))
    .limit(1);
  return events.length > 0 ? events[0].summary : null;
}

async function performCompaction(sessionId: string, activeMessages: any[]) {
  const [sys, ...rest] = activeMessages;
  if (rest.length <= KEEP_RECENT_MESSAGES) return;

  const toCompact = rest.slice(0, -KEEP_RECENT_MESSAGES);
  const prevSummary = await getPreviousSummary(sessionId);

  const transcript = toCompact
    .map((m) => `${m.role}: ${m.content.substring(0, 200)}`)
    .join("\n");

  const result = await generateText({
    model: openai("gpt-4-turbo"),
    prompt: `Summarize this coding session. Previous: ${prevSummary || "None"}\n\nNew:\n${transcript}`,
    maxTokens: 500,
  });

  await db.insert(compactionEvents).values({
    id: `evt_${Date.now()}`,
    sessionId,
    summary: result.text,
    compactedMessageIds: JSON.stringify(toCompact.map((m) => m.id)),
    tokenCount: result.usage?.totalTokens || 0,
    createdAt: new Date(),
  });

  await db
    .update(messages)
    .set({ compacted: true })
    .where(
      inArray(
        messages.id,
        toCompact.map((m) => m.id),
      ),
    );

  console.log(`✅ Compacted ${toCompact.length} messages`);
}

// ============================================================================
// 7. AGENT LOOP & TOOLS
// ============================================================================

const createTools = (containerId: string) => ({
  execute_command: tool({
    description: "Execute a shell command.",
    parameters: z.object({ command: z.string() }),
    execute: async ({ command }) => {
      console.log(`\n[CMD] ${command}`);
      try {
        return await executeCommand(containerId, command);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  }),
  read_file: tool({
    description: "Read file content.",
    parameters: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      console.log(`\n[READ] ${path}`);
      try {
        return await executeCommand(containerId, `cat ${path}`);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  }),
  write_file: tool({
    description: "Write content to file.",
    parameters: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      console.log(`\n[WRITE] ${path} (${content.length} chars)`);
      try {
        await writeFile(containerId, path, content);
        return "Success";
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  }),
  list_directory: tool({
    description: "List directory.",
    parameters: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      console.log(`\n[LS] ${path}`);
      try {
        return await executeCommand(containerId, `ls -la ${path}`);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  }),
  inspect_database: tool({
    description:
      "Run a SQL query directly against the SQLite database to verify data exists.",
    parameters: z.object({
      path: z.string().describe("Path to the .db or .sqlite file"),
      query: z
        .string()
        .describe("The SQL query to run (e.g., SELECT * FROM cards)"),
    }),
    execute: async ({ path, query }) => {
      console.log(`\n[SQL] ${query} (on ${path})`);
      try {
        return await executeCommand(
          containerId,
          `sqlite3 ${path} "${query}" -header -column`,
        );
      } catch (e: any) {
        return `SQL Error: ${e.message}`;
      }
    },
  }),
});

async function runAgent(sessionId: string, containerId: string, task: string) {
  const sysMsg = `You are a Verification-Obsessed Coding Agent.
  
  CORE RULE: "It didn't happen unless you verify it."
  
  1. WHEN CREATING DATA: You MUST use 'inspect_database' to prove the data is in the DB.
  2. WHEN WRITING CODE: Run it immediately.
  3. MOCKING AI: For the 'AI generation' part, simply write a function that returns mocked data or calls a free fake API. Do not need a real API key.
  4. SPACED REPETITION: You must demonstrate the review logic works by running the app in 'review' mode and showing the output.
  
  Goal: Build the app, then PROVE it works by listing the database rows in your final step.`;

  const initialMsgId = `msg_sys_${Date.now()}`;
  await db.insert(messages).values({
    id: initialMsgId,
    sessionId,
    role: "system",
    content: JSON.stringify(sysMsg),
    tokenCount: 0,
    createdAt: new Date(),
  });

  const userMsgId = `msg_user_${Date.now()}`;
  await db.insert(messages).values({
    id: userMsgId,
    sessionId,
    role: "user",
    content: JSON.stringify(task),
    tokenCount: 0,
    createdAt: new Date(),
  });

  let loopActive = true;
  let iteration = 0;

  while (loopActive && iteration < 30) {
    iteration++;

    const currentUsage = await getCurrentTokenUsage(sessionId);
    console.log(
      `\n--- Step ${iteration} | Last prompt tokens: ${currentUsage}/${CONTEXT_LIMIT} ---`,
    );

    if (currentUsage > CONTEXT_LIMIT * COMPACTION_THRESHOLD) {
      const activeMessages = await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)),
        )
        .orderBy(asc(messages.createdAt));

      await performCompaction(sessionId, activeMessages);
    }

    const activeMessages = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)),
      )
      .orderBy(asc(messages.createdAt));

    const summary = await getPreviousSummary(sessionId);
    const history: CoreMessage[] = activeMessages.map((m) => ({
      role: m.role as any,
      content: JSON.parse(m.content),
    }));

    if (history[0].role === "system" && summary) {
      history[0].content += `\n\n### MEMORY SUMMARY ###\n${summary}`;
    }

    const result = await generateText({
      model: openai("gpt-4-turbo"),
      messages: history,
      tools: createTools(containerId),
      maxSteps: 1,
    });

    if (result.usage) {
      await db.insert(apiCalls).values({
        id: `call_${Date.now()}`,
        sessionId,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        createdAt: new Date(),
      });

      console.log(
        `  📊 API: ${result.usage.promptTokens} prompt + ${result.usage.completionTokens} completion = ${result.usage.totalTokens} total`,
      );
    }

    for (const msg of result.response.messages) {
      const contentStr = JSON.stringify(msg.content);

      await db.insert(messages).values({
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2)}`,
        sessionId,
        role: msg.role,
        content: contentStr,
        tokenCount: 0,
        createdAt: new Date(),
      });
    }

    const lastMsg =
      result.response.messages[result.response.messages.length - 1];
    if (
      lastMsg.role === "assistant" &&
      !JSON.stringify(lastMsg.content).includes("tool-call")
    ) {
      console.log(`\n🤖 Agent Response: ${lastMsg.content as string}`);
      loopActive = false;
    }
  }
}

// ============================================================================
// 8. MAIN
// ============================================================================

async function main() {
  console.log("🚀 Starting Agent with API-Based Token Tracking");

  try {
    const sessionId = `sess_${Date.now()}`;
    const containerId = await createContainer();

    await db.insert(sessions).values({
      id: sessionId,
      createdAt: new Date(),
      containerId,
    });
    console.log(`📋 Session: ${sessionId}`);

    const rigorousTask = `
      Build a CLI Flashcard App (Anki clone) using TypeScript, Bun, and SQLite.
      
      REQUIREMENTS:
      1. DB: Create 'cards.db'. Table 'cards' (id, front, back, next_review, interval).
      2. AI: Implement 'generateCards(topic)'. Since we don't have an API key, MOCK this function to return 3 hardcoded cards for the given topic.
      3. LOGIC: Implement SM-2 algorithm for reviews.
      
      VERIFICATION STEPS (YOU MUST DO THIS):
      1. Run 'bun install' and setup the DB.
      2. Run the app to add cards for the topic "Chemistry".
      3. CRITICAL: Use the 'inspect_database' tool to SELECT * FROM cards and prove to me the data is there.
      4. Run the app in 'review' mode and show the output.
    `;

    await runAgent(sessionId, containerId, rigorousTask);

    await exportWorkspace(containerId, sessionId);

    console.log("\n🧹 Cleaning up container...");
    await executeCommand(containerId, "rm -rf /workspace");
    const container = docker.getContainer(containerId);
    await container.stop();

    console.log(`✨ Done! Your code is saved in ${OUTPUT_DIR}/${sessionId}/`);
  } catch (error) {
    console.error("FATAL ERROR:", error);
    process.exit(1);
  }
}

main();

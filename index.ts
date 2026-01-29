import { generateText, tool, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, desc, inArray, and, asc } from "drizzle-orm";
import Docker from "dockerode";
import { z } from "zod";

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

// Adjust these based on your model's limits
const CONTEXT_LIMIT = 5000; // Lower this from 20000
const COMPACTION_THRESHOLD = 0.8; // Trigger at 80% of limit
const KEEP_RECENT_MESSAGES = 6; // Keep last 6 messages uncompacted to maintain flow

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
  role: text("role").notNull(), // 'system' | 'user' | 'assistant' | 'tool'
  // We store content as a JSON string to handle complex ToolCall arrays from Vercel AI SDK
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
  compactedMessageIds: text("compacted_message_ids").notNull(), // JSON array of IDs
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
const isWindows = process.platform === "win32";

async function initializeDocker(): Promise<Docker> {
  const connectionAttempts: { name: string; config: Docker.DockerOptions }[] = [
    { name: "localhost:2375", config: { host: "localhost", port: 2375 } },
    {
      name: "host.docker.internal",
      config: { host: "host.docker.internal", port: 2375 },
    },
    { name: "Unix socket", config: { socketPath: "/var/run/docker.sock" } },
  ];

  for (const attempt of connectionAttempts) {
    if (isWindows && attempt.name === "Unix socket") continue;
    try {
      console.log(`Checking Docker at ${attempt.name}...`);
      const client = new Docker(attempt.config);
      await client.ping();
      console.log(`✅ Docker connected via ${attempt.name}`);
      return client;
    } catch (e) {
      // Ignore and try next
    }
  }

  console.error(
    "❌ Docker connection failed. Ensure Docker Desktop is running.",
  );
  process.exit(1);
}

// We initialize this at the top level for simplicity in this script
docker = await initializeDocker();

async function createContainer(): Promise<string> {
  console.log("Creating container (Image: oven/bun:1-alpine)...");
  // We use the oven/bun image so the agent has 'bun' available immediately
  // We rely on 'docker pull oven/bun:1-alpine' happening if not present
  try {
    const container = await docker.createContainer({
      Image: "oven/bun:1-alpine",
      Cmd: ["/bin/sh", "-c", "tail -f /dev/null"], // Keep alive
      WorkingDir: "/workspace",
      HostConfig: {
        AutoRemove: true, // Automatically clean up when stopped
      },
    });

    await container.start();
    return container.id;
  } catch (error: any) {
    if (error.statusCode === 404) {
      console.log("Pulling image oven/bun:1-alpine...");
      await new Promise((resolve, reject) => {
        docker.pull("oven/bun:1-alpine", (err: any, stream: any) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, onFinished, onProgress);
          function onFinished(err: any) {
            if (err) reject(err);
            else resolve(true);
          }
          function onProgress(event: any) {
            /* silent */
          }
        });
      });
      return createContainer(); // Retry
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
    stream.on("data", (chunk: Buffer) => {
      // Docker streams usually have an 8-byte header we should strip if multiplexed
      // However, dockerode sometimes handles this depending on options.
      // For safety with raw streams:
      const raw = chunk.toString();
      output += raw;
    });

    stream.on("end", () => {
      // Remove non-printable header characters if present (Docker header is usually 8 bytes)
      // A simple clean is often enough for text output
      // Note: This is a simplified stream reader.
      resolve(output.replace(/[\x00-\x09\x0B-\x1F\x7F].{0,7}/g, "").trim());
    });

    stream.on("error", (err) => reject(err));
  });
}

async function writeFile(
  containerId: string,
  path: string,
  content: string,
): Promise<void> {
  const container = docker.getContainer(containerId);

  // 1. Ensure directory exists
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) {
    const mkdirExec = await container.exec({ Cmd: ["mkdir", "-p", dir] });
    await mkdirExec.start({ Detach: false });
  }

  // 2. Write file using base64 to avoid shell escaping hell
  const b64Content = Buffer.from(content).toString("base64");
  const exec = await container.exec({
    Cmd: ["/bin/sh", "-c", `echo "${b64Content}" | base64 -d > ${path}`],
  });
  await exec.start({ Detach: false });
}

async function readFile(containerId: string, path: string): Promise<string> {
  return await executeCommand(containerId, `cat ${path}`);
}

async function listDirectory(
  containerId: string,
  path: string,
): Promise<string> {
  return await executeCommand(containerId, `ls -la ${path}`);
}

async function cleanupContainer(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
    await container.stop();
    // AutoRemove is set in creation, so it disappears
  } catch (e) {
    console.error("Error cleaning up container:", e);
  }
}

// ============================================================================
// 5. HELPER FUNCTIONS: TOKENS & STORAGE
// ============================================================================

// Simple heuristic for token counting
function estimateTokens(content: any): number {
  const str = typeof content === "string" ? content : JSON.stringify(content);
  return Math.ceil(str.length / 2); // Roughly 2 chars per token
}

// ============================================================================
// 6. CONTEXT COMPACTION LOGIC
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
  // We keep:
  // 1. The System Message (usually index 0)
  // 2. The last N messages (KEEP_RECENT_MESSAGES)
  // We compact: Everything in between.

  const systemMessages = activeMessages.filter((m) => m.role === "system");
  const otherMessages = activeMessages.filter((m) => m.role !== "system");

  if (otherMessages.length <= KEEP_RECENT_MESSAGES) {
    console.log("⚠️ Limit reached but not enough messages to compact safely.");
    return;
  }

  const messagesToCompact = otherMessages.slice(
    0,
    otherMessages.length - KEEP_RECENT_MESSAGES,
  );
  const idsToCompact = messagesToCompact.map((m) => m.id);

  console.log(`🔄 Compacting ${messagesToCompact.length} messages...`);

  // Prepare transcript for summarizer
  const transcript = messagesToCompact
    .map((m) => {
      let contentStr = "";
      try {
        const parsed = JSON.parse(m.content);
        if (typeof parsed === "string") contentStr = parsed;
        else if (Array.isArray(parsed)) {
          // Handle array content (tool calls etc)
          contentStr = parsed
            .map((p) => {
              if (p.type === "text") return p.text;
              if (p.type === "tool-call") return `[Tool Call: ${p.toolName}]`;
              if (p.type === "tool-result")
                return `[Tool Result: ${p.toolName}]`;
              return JSON.stringify(p);
            })
            .join(" ");
        }
      } catch (e) {
        contentStr = m.content;
      }
      return `${m.role.toUpperCase()}: ${contentStr}`;
    })
    .join("\n\n");

  const prevSummary = await getPreviousSummary(sessionId);

  const summaryPrompt = `
    You are a technical project manager supervising a coding agent.
    Summarize the following conversation history concisely.
    
    PREVIOUS SUMMARY:
    ${prevSummary || "None"}
    
    RECENT CONVERSATION TO MERGE:
    ${transcript}
    
    INSTRUCTIONS:
    1. Update the summary to reflect the current state of the project.
    2. List created files and their purposes.
    3. Note any outstanding errors or TODOs.
    4. Discard chatty conversation, focus on technical facts.
  `;

  const { text: newSummary } = await generateText({
    model: openai("gpt-4-turbo"),
    prompt: summaryPrompt,
  });

  // Save event
  await db.insert(compactionEvents).values({
    id: `evt_${Date.now()}`,
    sessionId,
    summary: newSummary,
    compactedMessageIds: JSON.stringify(idsToCompact),
    createdAt: new Date(),
  });

  // Mark messages as compacted
  await db
    .update(messages)
    .set({ compacted: true })
    .where(inArray(messages.id, idsToCompact));

  console.log(
    `✅ Compaction complete. New summary length: ${newSummary.length} chars.`,
  );
}

// ============================================================================
// 7. AGENT LOOP & TOOLS
// ============================================================================

const createTools = (containerId: string) => ({
  execute_command: tool({
    description:
      "Execute a shell command inside the container (e.g., bun run index.ts, ls -la, mkdir)",
    parameters: z.object({
      command: z.string().describe("The shell command to execute"),
    }),
    execute: async ({ command }) => {
      console.log(`\n[TOOL] Execute: ${command}`);
      try {
        const output = await executeCommand(containerId, command);
        console.log(
          `[TOOL] Output: ${output.substring(0, 100).replace(/\n/g, " ")}...`,
        );
        return output;
      } catch (error: any) {
        return `Error: ${error.message}`;
      }
    },
  }),
  read_file: tool({
    description: "Read contents of a file",
    parameters: z.object({
      path: z.string().describe("Path to the file"),
    }),
    execute: async ({ path }) => {
      console.log(`\n[TOOL] Read: ${path}`);
      try {
        return await readFile(containerId, path);
      } catch (error: any) {
        return `Error: ${error.message}`;
      }
    },
  }),
  write_file: tool({
    description: "Write content to a file (will overwrite)",
    parameters: z.object({
      path: z.string().describe("Path to the file"),
      content: z.string().describe("Full file content"),
    }),
    execute: async ({ path, content }) => {
      console.log(`\n[TOOL] Write: ${path} (${content.length} chars)`);
      try {
        await writeFile(containerId, path, content);
        return `Successfully wrote to ${path}`;
      } catch (error: any) {
        return `Error: ${error.message}`;
      }
    },
  }),
  list_directory: tool({
    description: "List contents of a directory",
    parameters: z.object({
      path: z.string().describe("Directory path"),
    }),
    execute: async ({ path }) => {
      console.log(`\n[TOOL] List: ${path}`);
      try {
        return await listDirectory(containerId, path);
      } catch (error: any) {
        return `Error: ${error.message}`;
      }
    },
  }),
});

async function runAgent(sessionId: string, containerId: string, task: string) {
  // 1. Initialize System Message
  const sysMsg = `You are an expert Coding Agent.
  ENVIRONMENT:
  - You are inside a Docker container running Alpine Linux.
  - 'bun' is installed and available.
  - You can write files and execute commands.
  
  RULES:
  1. IMPLEMENTATION: Write actual code to files. Do not just output markdown.
  2. VERIFICATION: After writing code, run it to verify it works.
  3. PERSISTENCE: If you need a database, use SQLite ('bun:sqlite').
  4. STEP-BY-STEP: Create files one by one, then verify.
  
  Your goal is to complete the user's request fully.`;

  await db.insert(messages).values({
    id: `msg_sys_${Date.now()}`,
    sessionId,
    role: "system",
    content: JSON.stringify(sysMsg),
    tokenCount: estimateTokens(sysMsg),
    createdAt: new Date(),
  });

  // 2. Add User Task
  await db.insert(messages).values({
    id: `msg_user_${Date.now()}`,
    sessionId,
    role: "user",
    content: JSON.stringify(task),
    tokenCount: estimateTokens(task),
    createdAt: new Date(),
  });

  let loopActive = true;
  let iteration = 0;
  const MAX_ITERATIONS = 50;

  while (loopActive && iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`\n--- Iteration ${iteration} ---`);

    // A. Fetch Active History
    const activeMessages = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)),
      )
      .orderBy(asc(messages.createdAt));

    // B. Check Token Usage & Compact if needed
    const totalTokens = activeMessages.reduce(
      (sum, m) => sum + m.tokenCount,
      0,
    );
    console.log(
      `Token Usage: ${totalTokens} / ${CONTEXT_LIMIT} (${Math.round((totalTokens / CONTEXT_LIMIT) * 100)}%)`,
    );

    if (totalTokens > CONTEXT_LIMIT * COMPACTION_THRESHOLD) {
      await performCompaction(sessionId, activeMessages);
      // Re-fetch after compaction
      const refreshedMessages = await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)),
        )
        .orderBy(asc(messages.createdAt));
      // Update our local reference
      activeMessages.length = 0;
      activeMessages.push(...refreshedMessages);
    }

    // C. Prepare Messages for LLM
    // 1. Get latest summary
    const summary = await getPreviousSummary(sessionId);

    // 2. Convert DB format to Vercel AI SDK CoreMessage format
    const history: CoreMessage[] = activeMessages.map((m) => {
      return {
        role: m.role as any,
        content: JSON.parse(m.content),
      };
    });

    // 3. Inject Summary into System Message
    // Find the system message (usually first)
    if (history.length > 0 && history[0].role === "system") {
      let content = history[0].content as string;
      if (summary) {
        content += `\n\n### CONTEXT SUMMARY ###\n${summary}\n\n(Old messages have been compacted. Use this summary as your memory.)`;
      }
      history[0].content = content;
    }

    // D. Call LLM
    // We use maxSteps: 1 to ensure we return to this loop after every turn
    // so we can check compaction logic again.
    const result = await generateText({
      model: openai("gpt-4-turbo"),
      messages: history,
      tools: createTools(containerId),
      maxSteps: 1,
    });

    // E. Save New Messages to DB
    // result.response.messages contains the new messages generated in this turn
    // (Assistant calls + Tool results if any)
    const newMessages = result.response.messages;

    for (const msg of newMessages) {
      // Clean content for storage
      // The SDK might give us mixed content arrays or strings.
      // We stringify everything for DB storage.
      const contentToStore = JSON.stringify(msg.content);

      await db.insert(messages).values({
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sessionId,
        role: msg.role,
        content: contentToStore,
        tokenCount: estimateTokens(contentToStore),
        createdAt: new Date(),
        compacted: false,
      });
    }

    // F. Check for Completion
    // If the assistant responded with pure text (no tool calls), it might be asking a question or declaring victory.
    // In a coding agent, usually, if it doesn't call a tool, it's either done or stuck.
    const lastMsg = newMessages[newMessages.length - 1];

    // Check if the last message is text-only from assistant
    let isTextOnly = false;
    if (lastMsg.role === "assistant") {
      if (typeof lastMsg.content === "string") isTextOnly = true;
      else if (Array.isArray(lastMsg.content)) {
        // Check if there are no tool calls
        const hasToolCall = lastMsg.content.some(
          (c: any) => c.type === "tool-call",
        );
        isTextOnly = !hasToolCall;
      }
    }

    if (isTextOnly) {
      console.log(
        "\nAgent did not trigger any tools. Assuming wait state or completion.",
      );
      // We can also check if the text contains "DONE" or similar if we prompted it to do so.
      // For now, we'll stop if it stops using tools to prevent infinite chat loops.
      // BUT, to be safe, we print the message and break.
      let textContent = "";
      if (typeof lastMsg.content === "string") textContent = lastMsg.content;
      else if (Array.isArray(lastMsg.content))
        textContent = lastMsg.content.map((c: any) => c.text || "").join("");

      console.log("Response:", textContent);
      loopActive = false;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    console.log("⚠️ Max iterations reached. Stopping.");
  }
}

// ============================================================================
// 8. MAIN ENTRY POINT
// ============================================================================

async function main() {
  console.log("🚀 Starting Context-Compacting Coding Agent");

  try {
    // 1. Setup Session
    const sessionId = `sess_${Date.now()}`;
    const containerId = await createContainer();

    await db.insert(sessions).values({
      id: sessionId,
      createdAt: new Date(),
      containerId,
    });

    console.log(`\n📋 Session: ${sessionId}`);
    console.log(`📦 Container: ${containerId}`);

    // 2. Define the complex test task
    const complexTask = `
      Build a CLI Flashcard App (Anki clone) in this container.
      
      REQUIREMENTS:
      1. Stack: TypeScript, Bun, SQLite.
      2. Database: Create a 'cards.db' with a 'cards' table (id, front, back, next_review_time).
      3. Logic: Implement a simple SM-2 spaced repetition algorithm function.
      4. AI: Create a function 'generateCards(topic)' that simulates calling an AI (just mock it for now to return 3 fixed cards about the topic).
      5. Interface: Create an 'index.ts' that lets a user add a card or review due cards via CLI args.
      
      EXECUTION:
      - Initialize the project (package.json).
      - Install dependencies (drizzle-orm, bun-sqlite, etc).
      - Write the code files.
      - Run the app to prove it works by adding a card and listing it.
    `;

    // 3. Run Agent
    await runAgent(sessionId, containerId, complexTask);

    // 4. Cleanup
    console.log("\n🧹 Cleaning up container...");
    await cleanupContainer(containerId);
    console.log("✨ Done.");
  } catch (error) {
    console.error("FATAL ERROR:", error);
    process.exit(1);
  }
}

// Start
main();

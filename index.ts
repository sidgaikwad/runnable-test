import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, and, inArray } from "drizzle-orm";
import Docker from "dockerode";
import { z } from "zod";

// Config
const CONTEXT_LIMIT = 5000;
const COMPACTION_THRESHOLD = 0.8;
const KEEP_RECENT = 5;

// Schema
const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  containerId: text("container_id"),
});

const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  compacted: integer("compacted", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

const compactions = sqliteTable("compactions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  summary: text("summary").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// DB Init
const db = drizzle(new Database("agent.db"));
new Database("agent.db").exec(`
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER, container_id TEXT);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, compacted INTEGER DEFAULT 0, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS compactions (id TEXT PRIMARY KEY, session_id TEXT, summary TEXT, created_at INTEGER);
`);

// Docker
const docker = new Docker({ host: "localhost", port: 2375 });

async function createContainer() {
  const c = await docker.createContainer({
    Image: "node:20-alpine",
    Cmd: ["/bin/sh", "-c", "tail -f /dev/null"],
    WorkingDir: "/workspace",
  });
  await c.start();
  return c.id;
}

async function execCmd(cid: string, cmd: string) {
  const exec = await docker.getContainer(cid).exec({
    Cmd: ["/bin/sh", "-c", cmd],
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/workspace",
  });
  const stream = await exec.start({ Detach: false, Tty: false });
  return new Promise<string>((res) => {
    let out = "";
    stream.on("data", (d: Buffer) => (out += d.toString().slice(8)));
    stream.on("end", () => res(out.trim()));
  });
}

async function writeFile(cid: string, path: string, content: string) {
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir) await execCmd(cid, `mkdir -p ${dir}`);
  await execCmd(cid, `cat > ${path} << 'EOF'\n${content}\nEOF`);
}

// Compaction (23 lines)
async function compact(sid: string) {
  const msgs = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sid), eq(messages.compacted, false)))
    .orderBy(messages.createdAt);
  if (msgs.length <= KEEP_RECENT + 1) return;

  const [sys, ...rest] = msgs;
  const toCompact = rest.slice(0, -KEEP_RECENT);
  const summaries = await db
    .select()
    .from(compactions)
    .where(eq(compactions.sessionId, sid))
    .orderBy(compactions.createdAt);
  const prevSummary = summaries[summaries.length - 1]?.summary || "";

  const transcript = toCompact
    .map((m) => `${m.role}: ${m.content.substring(0, 200)}`)
    .join("\n");
  const result = await generateText({
    model: openai("gpt-4-turbo"),
    prompt: `Summarize this coding session. Previous: ${prevSummary}\n\nNew:\n${transcript}`,
    maxTokens: 500,
  });

  await db
    .insert(compactions)
    .values({
      id: `c_${Date.now()}`,
      sessionId: sid,
      summary: result.text,
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
  await db.insert(messages).values({
    id: `m_sum_${Date.now()}`,
    sessionId: sid,
    role: "assistant",
    content: `[SUMMARY]: ${result.text}`,
    createdAt: new Date(),
  });

  console.log(`✅ Compacted ${toCompact.length} messages`);
}

// Agent
async function runAgent(sid: string, cid: string, task: string) {
  await db.insert(messages).values({
    id: `m_${Date.now()}`,
    sessionId: sid,
    role: "system",
    content: "You build working code. Use write_file, execute_command tools.",
    createdAt: new Date(),
  });

  await db.insert(messages).values({
    id: `m_${Date.now() + 1}`,
    sessionId: sid,
    role: "user",
    content: task,
    createdAt: new Date(),
  });

  let step = 0;
  let lastTokens = 0;

  while (step++ < 20) {
    const msgs = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sid), eq(messages.compacted, false)))
      .orderBy(messages.createdAt);

    const history = msgs.map((m) => ({
      role: m.role as any,
      content: m.content,
    }));

    console.log(
      `\nStep ${step} | Prompt Tokens: ${lastTokens}/${CONTEXT_LIMIT}`,
    );

    const result = await generateText({
      model: openai("gpt-4-turbo"),
      messages: history,
      tools: {
        execute_command: {
          description: "Run shell command",
          parameters: z.object({ command: z.string() }),
          execute: async ({ command }) => {
            console.log(`[CMD] ${command}`);
            return await execCmd(cid, command);
          },
        },
        write_file: {
          description: "Write file",
          parameters: z.object({ path: z.string(), content: z.string() }),
          execute: async ({ path, content }) => {
            console.log(`[WRITE] ${path}`);
            await writeFile(cid, path, content);
            return "OK";
          },
        },
        read_file: {
          description: "Read file",
          parameters: z.object({ path: z.string() }),
          execute: async ({ path }) => await execCmd(cid, `cat ${path}`),
        },
        list_directory: {
          description: "List directory",
          parameters: z.object({ path: z.string() }),
          execute: async ({ path }) => await execCmd(cid, `ls -la ${path}`),
        },
      },
      maxSteps: 1,
    });

    lastTokens = result.usage?.promptTokens || 0;

    for (const msg of result.response.messages) {
      await db.insert(messages).values({
        id: `m_${Date.now()}_${Math.random()}`,
        sessionId: sid,
        role: msg.role,
        content: JSON.stringify(msg.content),
        createdAt: new Date(),
      });
    }

    if (lastTokens > CONTEXT_LIMIT * COMPACTION_THRESHOLD) {
      await compact(sid);
    }

    if (!result.toolCalls || result.toolCalls.length === 0) break;
  }
}

// Main
async function main() {
  const sid = `s_${Date.now()}`;
  const cid = await createContainer();

  await db
    .insert(sessions)
    .values({ id: sid, createdAt: new Date(), containerId: cid });

  await runAgent(
    sid,
    cid,
    `Build flashcard app: SQLite storage, SM-2 spaced repetition, AI card generation (mocked), TypeScript+Bun. Create working files.`,
  );

  await docker.getContainer(cid).stop();
  console.log("✅ Done!");
}

main();

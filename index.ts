import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { eq, desc, inArray, and } from 'drizzle-orm';
import Docker from 'dockerode';
import { z } from 'zod';
// ============================================================================
// DATABASE SCHEMA
// ============================================================================

const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  containerId: text('container_id'),
});

const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  tokenCount: integer('token_count').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  compacted: integer('compacted', { mode: 'boolean' }).notNull().default(false),
});

const compactionEvents = sqliteTable('compaction_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  summary: text('summary').notNull(),
  compactedMessageIds: text('compacted_message_ids').notNull(), // JSON array
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// DATABASE SETUP
// ============================================================================

const sqlite = new Database('agent.db');
const db = drizzle(sqlite);

// Create tables if they don't exist
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

console.log('✅ Database schema initialized');

// ============================================================================
// DOCKER FUNCTIONS
// ============================================================================

console.log('Initializing Docker connection...');
console.log('Platform:', process.platform);

// Try multiple Docker connection methods
let docker: Docker;
const isWindows = process.platform === 'win32';

async function initializeDocker(): Promise<Docker> {
  const connectionAttempts: { name: string; config: Docker.DockerOptions }[] = [
    { name: 'localhost:2375', config: { host: 'localhost', port: 2375 } },
    { name: 'host.docker.internal:2375', config: { host: 'host.docker.internal', port: 2375 } },
    { name: '127.0.0.1:2375', config: { host: '127.0.0.1', port: 2375 } },
  ];

  if (!isWindows) {
    connectionAttempts.unshift({ 
      name: 'Unix socket', 
      config: { socketPath: '/var/run/docker.sock' } 
    });
  }

  for (const attempt of connectionAttempts) {
    try {
      console.log(`Trying Docker connection: ${attempt.name}...`);
      const dockerClient = new Docker(attempt.config);
      await dockerClient.ping();
      console.log(`✅ Docker connected via ${attempt.name}`);
      return dockerClient;
    } catch (error: any) {
      console.log(`❌ Failed to connect via ${attempt.name}: ${error.message || error.code}`);
    }
  }

  // If all attempts failed, show helpful error
  console.error('\n❌ DOCKER CONNECTION FAILED - All attempts exhausted\n');
  console.error('Please check:');
  console.error('1. Docker Desktop is RUNNING');
  console.error('2. Docker Desktop → Settings → General');
  console.error('3. Enable: "Expose daemon on tcp://localhost:2375 without TLS"');
  console.error('4. Click "Apply & Restart"');
  console.error('5. Wait for Docker to fully restart\n');
  console.error('Verify with: curl http://localhost:2375/_ping');
  console.error('Should return: OK\n');
  
  process.exit(1);
}

docker = await initializeDocker();

async function createContainer(): Promise<string> {
  const container = await docker.createContainer({
    Image: 'node:20-alpine',
    Cmd: ['/bin/sh', '-c', 'tail -f /dev/null'],
    WorkingDir: '/workspace',
    HostConfig: {
      AutoRemove: false,
    },
  });
  
  await container.start();
  return container.id;
}

async function executeCommand(containerId: string, command: string): Promise<string> {
  const container = docker.getContainer(containerId);
  
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: '/workspace',
  });
  
  const stream = await exec.start({ Detach: false, Tty: false });
  
  return new Promise((resolve, reject) => {
    let output = '';
    
    stream.on('data', (chunk: Buffer) => {
      // Remove Docker stream header (8 bytes)
      const data = chunk.length > 8 ? chunk.slice(8).toString() : chunk.toString();
      output += data;
    });
    
    stream.on('end', () => {
      resolve(output.trim());
    });
    
    stream.on('error', (err: Error) => {
      reject(err);
    });
  });
}

async function readFile(containerId: string, path: string): Promise<string> {
  const container = docker.getContainer(containerId);
  
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', `cat ${path}`],
    AttachStdout: true,
    AttachStderr: true,
  });
  
  const stream = await exec.start({ Detach: false, Tty: false });
  
  return new Promise((resolve, reject) => {
    let output = '';
    
    stream.on('data', (chunk: Buffer) => {
      const data = chunk.length > 8 ? chunk.slice(8).toString() : chunk.toString();
      output += data;
    });
    
    stream.on('end', () => {
      resolve(output.trim());
    });
    
    stream.on('error', (err: Error) => {
      reject(err);
    });
  });
}

async function writeFile(containerId: string, path: string, content: string): Promise<void> {
  const container = docker.getContainer(containerId);
  
  // Create directory first
  const dir = path.substring(0, path.lastIndexOf('/'));
  if (dir) {
    const mkdirExec = await container.exec({
      Cmd: ['/bin/sh', '-c', `mkdir -p ${dir}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    await mkdirExec.start({ Detach: false, Tty: false });
  }
  
  // Write file using cat with heredoc
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', `cat > ${path} << 'EOFMARKER'\n${content}\nEOFMARKER`],
    AttachStdout: true,
    AttachStderr: true,
  });
  
  await exec.start({ Detach: false, Tty: false });
}

async function listDirectory(containerId: string, path: string): Promise<string> {
  const container = docker.getContainer(containerId);
  
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', `ls -la ${path}`],
    AttachStdout: true,
    AttachStderr: true,
  });
  
  const stream = await exec.start({ Detach: false, Tty: false });
  
  return new Promise((resolve, reject) => {
    let output = '';
    
    stream.on('data', (chunk: Buffer) => {
      const data = chunk.length > 8 ? chunk.slice(8).toString() : chunk.toString();
      output += data;
    });
    
    stream.on('end', () => {
      resolve(output.trim());
    });
    
    stream.on('error', (err: Error) => {
      reject(err);
    });
  });
}

async function cleanupContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId);
  await container.stop();
  await container.remove();
}

// ============================================================================
// TOKEN COUNTING
// ============================================================================

function estimateTokens(text: string): number {
  // Simple heuristic: approximately 4 characters per token
  return Math.ceil(text.length / 4);
}

// ============================================================================
// CONTEXT COMPACTION
// ============================================================================

const CONTEXT_LIMIT = 5000; // tokens (lowered for testing - change to 128000 for production)
const COMPACTION_THRESHOLD = 0.8; // 80% (triggers at 4000 tokens)
const KEEP_RECENT_MESSAGES = 5; // Keep fewer messages to trigger compaction faster

function calculateTotalTokens(messages: any[]): number {
  return messages.reduce((sum, msg) => sum + (msg.tokenCount || 0), 0);
}

function shouldCompact(totalTokens: number): boolean {
  return totalTokens > (CONTEXT_LIMIT * COMPACTION_THRESHOLD);
}

async function getPreviousSummary(sessionId: string): Promise<string | null> {
  const events = await db
    .select()
    .from(compactionEvents)
    .where(eq(compactionEvents.sessionId, sessionId))
    .orderBy(desc(compactionEvents.createdAt))
    .limit(1);
  
  return events.length > 0 ? events[0].summary : null;
}

// ============================================================================
// AGENT LOOP
// ============================================================================

async function runAgent(sessionId: string, containerId: string, userQuery: string) {
  // Save user message
  const userMessageId = `msg_${Date.now()}`;
  await db.insert(messages).values({
    id: userMessageId,
    sessionId,
    role: 'user',
    content: userQuery,
    tokenCount: estimateTokens(userQuery),
    createdAt: new Date(),
    compacted: false,
  });
  
  let currentStep = 0;
  let continueLoop = true;
  let finalResponse = '';
  
  while (continueLoop && currentStep < 20) {
    // Get all messages from DB
    const allMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt);
    
    // Calculate total tokens
    const totalTokens = calculateTotalTokens(allMessages);
    console.log(`\nStep ${currentStep + 1}: Token count: ${totalTokens}/${CONTEXT_LIMIT}`);
    
    // Check if compaction needed
    if (totalTokens > (CONTEXT_LIMIT * COMPACTION_THRESHOLD)) {
      console.log(`🔄 COMPACTING CONTEXT (${totalTokens} tokens exceeds threshold)`);
      
      // Get non-compacted messages
      const nonCompactedMessages = allMessages.filter(m => !m.compacted);
      
      // Keep system message and last N messages
      const systemMessages = nonCompactedMessages.filter(m => m.role === 'system');
      const otherMessages = nonCompactedMessages.filter(m => m.role !== 'system');
      const recentMessages = otherMessages.slice(-KEEP_RECENT_MESSAGES);
      const messagesToCompact = otherMessages.slice(0, -KEEP_RECENT_MESSAGES);
      
      if (messagesToCompact.length > 0) {
        // Get previous summary
        const previousSummary = await getPreviousSummary(sessionId);
        
        // Generate summary
        const messagesText = messagesToCompact
          .map(msg => `[${msg.role}]: ${msg.content}`)
          .join('\n\n');
        
        const summaryPrompt = `Summarize the following conversation history between a user and a coding agent.
Focus on:
1. The main task/goal
2. Key files created and their purposes
3. Important decisions or approaches taken
4. Current progress and state
5. Any blockers or errors

${previousSummary ? `Previous summary:\n${previousSummary}\n\n` : ''}

Messages to summarize:
${messagesText}

Provide a concise summary that allows the agent to continue working effectively.`;

        const summaryResult = await generateText({
          model: openai('gpt-4-turbo'),
          prompt: summaryPrompt,
          maxTokens: 1000,
        });
        
        const summary = summaryResult.text;
        
        // Save compaction event
        const compactionId = `compaction_${Date.now()}`;
        await db.insert(compactionEvents).values({
          id: compactionId,
          sessionId,
          summary,
          compactedMessageIds: JSON.stringify(messagesToCompact.map(m => m.id)),
          createdAt: new Date(),
        });
        
        // Mark old messages as compacted
        const idsToCompact: string[] = messagesToCompact.map(m => m.id);
        await db
          .update(messages)
          .set({ compacted: true })
          .where(inArray(messages.id, idsToCompact));
        
        // Create summary message
        const summaryMessageId = `msg_summary_${Date.now()}`;
        await db.insert(messages).values({
          id: summaryMessageId,
          sessionId,
          role: 'assistant',
          content: `[CONTEXT SUMMARY]: ${summary}`,
          tokenCount: estimateTokens(summary),
          createdAt: new Date(),
          compacted: false,
        });
        
        console.log(`✅ Compacted ${messagesToCompact.length} messages into summary`);
      }
    }
    
    // Rebuild message history from non-compacted messages
    const activeMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.compacted, false)))
      .orderBy(messages.createdAt);
    
    const messageHistory = activeMessages.map((msg: any) => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content,
    }));
    
    console.log(`Starting agent with ${messageHistory.length} messages in context...`);
    
    // Run one step
    const result = await generateText({
      model: openai('gpt-4-turbo'),
      messages: messageHistory,
      tools: {
        execute_command: {
          description: 'Execute a shell command inside the Docker container',
          parameters: z.object({
            command: z.string().describe('The shell command to execute'),
          }),
          execute: async ({ command }) => {
            console.log(`[TOOL] Executing command: ${command}`);
            try {
              const output = await executeCommand(containerId, command);
              console.log(`[TOOL] Command output: ${output.substring(0, 200)}...`);
              return output;
            } catch (error: any) {
              console.log(`[TOOL] Command error: ${error.message}`);
              return `Error: ${error.message}`;
            }
          },
        },
        read_file: {
          description: 'Read the contents of a file from the Docker container',
          parameters: z.object({
            path: z.string().describe('The path to the file to read'),
          }),
          execute: async ({ path }) => {
            console.log(`[TOOL] Reading file: ${path}`);
            try {
              const content = await readFile(containerId, path);
              console.log(`[TOOL] File read successfully, length: ${content.length}`);
              return content;
            } catch (error: any) {
              console.log(`[TOOL] Read error: ${error.message}`);
              return `Error: ${error.message}`;
            }
          },
        },
        write_file: {
          description: 'Write content to a file in the Docker container',
          parameters: z.object({
            path: z.string().describe('The path where the file should be written'),
            content: z.string().describe('The content to write to the file'),
          }),
          execute: async ({ path, content }) => {
            console.log(`[TOOL] Writing file: ${path} (${content.length} chars)`);
            try {
              await writeFile(containerId, path, content);
              console.log(`[TOOL] File written successfully`);
              return `File written successfully to ${path}`;
            } catch (error: any) {
              console.log(`[TOOL] Write error: ${error.message}`);
              return `Error: ${error.message}`;
            }
          },
        },
        list_directory: {
          description: 'List the contents of a directory in the Docker container',
          parameters: z.object({
            path: z.string().describe('The path to the directory to list'),
          }),
          execute: async ({ path }) => {
            console.log(`[TOOL] Listing directory: ${path}`);
            try {
              const listing = await listDirectory(containerId, path);
              console.log(`[TOOL] Directory listed successfully`);
              return listing;
            } catch (error: any) {
              console.log(`[TOOL] List error: ${error.message}`);
              return `Error: ${error.message}`;
            }
          },
        },
      },
      maxSteps: 1, // Only do one step at a time so we can check compaction
    });

    // Save assistant response and tool results
    // Process each step - steps contain tool calls and results
    for (const step of result.steps) {
      // Save tool calls and results as assistant messages
      if (step.toolCalls && step.toolCalls.length > 0) {
        const msgId = `msg_step_${Date.now()}_${Math.random()}`;
        
        // Format tool calls and results for storage
        let content = '';
        for (let i = 0; i < step.toolCalls.length; i++) {
          const toolCall = step.toolCalls[i];
          const toolResult = step.toolResults ? step.toolResults[i] : null;
          
          content += `[TOOL CALL: ${toolCall.toolName}]\n`;
          content += `Args: ${JSON.stringify(toolCall.args)}\n`;
          if (toolResult) {
            const resultStr = typeof toolResult.result === 'string' 
              ? toolResult.result.substring(0, 500) 
              : JSON.stringify(toolResult.result).substring(0, 500);
            content += `Result: ${resultStr}\n\n`;
          }
        }
        
        await db.insert(messages).values({
          id: msgId,
          sessionId,
          role: 'assistant',
          content: content.trim(),
          tokenCount: estimateTokens(content),
          createdAt: new Date(),
          compacted: false,
        });
      }
      
      // Save text response if present
      if (step.text) {
        const msgId = `msg_text_${Date.now()}_${Math.random()}`;
        await db.insert(messages).values({
          id: msgId,
          sessionId,
          role: 'assistant',
          content: step.text,
          tokenCount: estimateTokens(step.text),
          createdAt: new Date(),
          compacted: false,
        });
        finalResponse = step.text;
      }
    }
    
    // Also save final text if present
    if (result.text && !result.steps.some(s => s.text === result.text)) {
      const msgId = `msg_final_${Date.now()}_${Math.random()}`;
      await db.insert(messages).values({
        id: msgId,
        sessionId,
        role: 'assistant',
        content: result.text,
        tokenCount: estimateTokens(result.text),
        createdAt: new Date(),
        compacted: false,
      });
      finalResponse = result.text;
    }
    
    // Check if we should continue
    const lastStep = result.steps[result.steps.length - 1];
    if (lastStep && lastStep.finishReason === 'stop') {
      continueLoop = false;
    }
    
    currentStep++;
  }

  console.log('\n=== Agent completed ===');
  
  return finalResponse;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function main() {
  try {
    // Create a new session
    const sessionId = `session_${Date.now()}`;
    console.log(`Creating session: ${sessionId}`);
    
    // Create Docker container
    console.log('Creating Docker container...');
    const containerId = await createContainer();
    console.log(`Container created: ${containerId}`);
    
    // Save session
    await db.insert(sessions).values({
      id: sessionId,
      createdAt: new Date(),
      containerId,
    });
    
    // Add system message
    const systemMessageId = `msg_system_${Date.now()}`;
    await db.insert(messages).values({
      id: systemMessageId,
      sessionId,
      role: 'system',
      content: `You are a coding agent that MUST use tools to write actual working code. You have access to a Docker container where you can execute commands and create files.

CRITICAL RULES:
1. You MUST create actual files using write_file tool - never just describe code
2. You MUST execute commands to test your code
3. You MUST build working applications, not just explain how to build them
4. Always use the tools available to you: execute_command, write_file, read_file, list_directory
5. Work step by step, creating files one at a time
6. Test your code after creating it

Available tools:
- write_file: Create code files in the container
- execute_command: Run shell commands and test code
- read_file: Read files you created
- list_directory: See what files exist

Your goal is to BUILD and DELIVER working code, not just describe it.`,
      tokenCount: estimateTokens('You are a coding agent that MUST use tools to write actual working code...'),
      createdAt: new Date(),
      compacted: false,
    });
    
    // Test task from requirements
    const testTask = `BUILD a working flashcard app like Anki with AI integration in the Docker container. 

Requirements:
1. Create actual TypeScript files with working code
2. Store flashcards with front/back content in SQLite database
3. Implement spaced repetition using SM-2 algorithm
4. Include an AI feature that generates flashcards from a topic
5. Use TypeScript with Bun runtime

You MUST:
- Use write_file to create all necessary .ts files
- Set up the SQLite database
- Write complete, working code
- Test it with execute_command
- Create a working application, not just a code example

Start by creating the project structure and files one by one.`;
    
    console.log('\n=== Starting Agent ===\n');
    const response = await runAgent(sessionId, containerId, testTask);
    console.log('\n=== Agent Response ===\n');
    console.log(response);
    
    // Cleanup
    console.log('\nCleaning up...');
    await cleanupContainer(containerId);
    console.log('Done!');
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the agent
main();
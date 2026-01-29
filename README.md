# Context-Compacting Coding Agent

A coding agent that automatically compacts conversation history when approaching the model's context window limit.

## Requirements

- Bun runtime installed
- Docker installed and running
- OpenAI API key

## Setup

1. **Install Bun** (if not already installed):
```bash
curl -fsSL https://bun.sh/install | bash
```

2. **Install dependencies**:
```bash
bun install
```

3. **Set up environment variables**:
```bash
cp .env.example .env
# Edit .env and add your OpenAI API key
```

4. **Make sure Docker is running**:
```bash
docker ps
```

## Usage

Run the agent:
```bash
bun run index.ts
```

The agent will:
1. Create a new session
2. Start a Docker container for sandboxed execution
3. Run the test task (building a flashcard app)
4. Automatically compact context when approaching token limits
5. Clean up the Docker container when done

## How It Works

### Database Schema
- **sessions**: Stores session information and container IDs
- **messages**: Stores all conversation messages with token counts
- **compaction_events**: Logs context compaction events

### Context Compaction
- Tracks token usage for each message
- Triggers at 80% of context limit (102,400 tokens for 128k context)
- Keeps last 15 messages intact
- Summarizes older messages using LLM
- Chains summaries across multiple compactions

### Tools Available
- `execute_command`: Run shell commands in Docker container
- `read_file`: Read files from container
- `write_file`: Write files to container
- `list_directory`: List directory contents

## Configuration

Edit these constants in `index.ts` to customize:

```typescript
const CONTEXT_LIMIT = 128000; // Token limit for the model
const COMPACTION_THRESHOLD = 0.8; // Trigger at 80%
const KEEP_RECENT_MESSAGES = 15; // Number of recent messages to keep
```

## Test Task

The agent is tested with building a flashcard app that includes:
- SQLite storage for flashcards
- Spaced repetition (SM-2 algorithm)
- AI-powered flashcard generation
- TypeScript + Bun implementation

## Database Location

The SQLite database is stored in `agent.db` in the current directory.

## Troubleshooting

### Docker Issues
- Make sure Docker daemon is running: `docker ps`
- Check Docker permissions: `sudo usermod -aG docker $USER`

### API Key Issues
- Verify your OpenAI API key is set in `.env`
- Check API key has sufficient credits

### Token Limit
- If you hit token limits, adjust `CONTEXT_LIMIT` or `COMPACTION_THRESHOLD`
- Reduce `KEEP_RECENT_MESSAGES` to compact more aggressively

## Architecture

```
User Query
    ↓
Agent (Vercel AI SDK with generateText)
    ↓
Tools (execute, read, write, list)
    ↓
Docker Container (sandboxed execution)
    ↓
Results saved to SQLite with token counts
    ↓
Token counting & compaction check
    ↓
If needed: LLM summarizes old messages
    ↓
Continue with compacted context
```

## Files

- `index.ts`: Single-file implementation (all code)
- `package.json`: Dependencies
- `agent.db`: SQLite database (created on first run)
- `.env`: Environment variables (create from .env.example)
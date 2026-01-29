import { Database } from "bun:sqlite";

const db = new Database("cards.db");

// 1. DATABASE SETUP
try {
  db.run(`CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    front TEXT,
    back TEXT,
    next_review DATE,
    interval INTEGER
  );`);
} catch (error) {
  console.error("Error creating table:", error);
}

// 2. SM-2 ALGORITHM (Simplified)
function calculateNextReview(
  currentInterval: number,
  grade: number,
): { interval: number; date: string } {
  // Grade: 0=Fail, 1=Hard, 2=Good, 3=Easy
  let newInterval = 1;

  if (grade >= 2) {
    if (currentInterval === 0) newInterval = 1;
    else if (currentInterval === 1) newInterval = 6;
    else newInterval = Math.round(currentInterval * 2.5);
  } else {
    newInterval = 1; // Reset if failed
  }

  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + newInterval);

  return {
    interval: newInterval,
    date: nextDate.toISOString().split("T")[0] ?? "",
  };
}

// 3. GENERATE CARDS (Mock AI)
function generateCards(topic: string) {
  // In a real app, this would call OpenAI/Gemini
  if (topic.toLowerCase() === "chemistry") {
    return [
      { front: "Atom", back: "Basic unit of matter" },
      { front: "H2O", back: "Water" },
      { front: "pH > 7", back: "Base/Alkaline" },
    ];
  }
  return [
    { front: `${topic} Concept 1`, back: "Definition 1" },
    { front: `${topic} Concept 2`, back: "Definition 2" },
    { front: `${topic} Concept 3`, back: "Definition 3" },
  ];
}

// 4. APP ACTIONS
function addCards(topic: string) {
  console.log(`\n🤖 Generating cards for topic: ${topic}...`);
  const cards = generateCards(topic);

  const stmt = db.prepare(
    "INSERT INTO cards (front, back, next_review, interval) VALUES (?, ?, ?, ?)",
  );
  const today = new Date().toISOString().split("T")[0] || "";

  db.transaction(() => {
    for (const card of cards) {
      stmt.run(card.front, card.back, today as string, 0);
    }
  })();

  console.log(`✅ Added ${cards.length} cards!`);
}

function reviewCards() {
  const today = new Date().toISOString().split("T")[0];
  const dueCards = db
    .query("SELECT * FROM cards WHERE next_review <= ?")
    .all(today ?? "") as any[];

  if (dueCards.length === 0) {
    console.log("\n🎉 No cards due for review today!");
    return;
  }

  console.log(`\n📚 Reviewing ${dueCards.length} cards due today...\n`);

  for (const card of dueCards) {
    console.log(`-----------------------------------`);
    console.log(`FRONT: ${card.front}`);
    // Simulate user thinking (in a real CLI we would wait for input)
    console.log(`BACK:  ${card.back}`);

    // Simulate a "Good" rating (2) for testing
    const grade = 2;
    const result = calculateNextReview(card.interval, grade);

    db.run(
      "UPDATE cards SET next_review = ?, interval = ? WHERE id = ?",
      result.date,
      result.interval,
      card.id,
    );

    console.log(`> Rated 'Good'. Next review: ${result.date}`);
  }
}

function listCards() {
  const cards = db.query("SELECT * FROM cards").all();
  console.table(cards);
}

// 5. CLI HANDLER
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case "add":
    if (!arg)
      console.log(
        "Please specify a topic. Usage: bun run index.ts add <topic>",
      );
    else addCards(arg);
    break;
  case "review":
    reviewCards();
    break;
  case "list":
    listCards();
    break;
  default:
    console.log("\nUsage:");
    console.log("  bun run index.ts add <topic>   # Generate and add cards");
    console.log("  bun run index.ts review        # Review due cards");
    console.log("  bun run index.ts list          # Show database content");
}

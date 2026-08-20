import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve("integrations/skills/memorygraph/SKILL.md");
const text = readFileSync(path, "utf8");
const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
if (!match) throw new Error("SKILL.md must start with YAML frontmatter");
const lines = match[1].split("\n").filter(Boolean);
const keys = lines.map((line) => line.split(":", 1)[0]?.trim()).filter(Boolean);
if (!keys.includes("name") || !keys.includes("description")) throw new Error("SKILL.md requires name and description");
if (keys.some((key) => !["name", "description"].includes(key))) throw new Error("SKILL.md frontmatter may only contain name and description");
if (!/^name:\s*memorygraph\s*$/mu.test(match[1])) throw new Error("Skill name must be memorygraph");
process.stdout.write("MemoryGraph Skill is valid.\n");


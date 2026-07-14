import { mkdir, writeFile } from "node:fs/promises";
import { graph } from "@/graph/main/graph.js";

const outputDir = "static/graphs";

await mkdir(outputDir, { recursive: true });

const drawableGraph = await graph.getGraphAsync();

const mermaid = drawableGraph.drawMermaid();
await writeFile(`${outputDir}/main-agent.mmd`, mermaid);

const png = await drawableGraph.drawMermaidPng();
const buffer = Buffer.from(await png.arrayBuffer());
await writeFile(`${outputDir}/main-agent.png`, buffer);

process.exit(0);

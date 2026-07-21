import { mkdir, writeFile } from "node:fs/promises";
import { graph } from "@/workflow/main/graph.js";

const outputDir = "static/workflow";

await mkdir(outputDir, { recursive: true });

await renderGraph("main-agent", await graph.getGraphAsync({ xray: false }));


async function renderGraph(
  fileName: string,
  drawableGraph: Awaited<ReturnType<typeof graph.getGraphAsync>>
): Promise<void> {
  const mermaid = drawableGraph.drawMermaid();
  await writeFile(`${outputDir}/${fileName}.mmd`, mermaid);

  const png = await drawableGraph.drawMermaidPng();
  const buffer = Buffer.from(await png.arrayBuffer());
  await writeFile(`${outputDir}/${fileName}.png`, buffer);
}

process.exit(0);
